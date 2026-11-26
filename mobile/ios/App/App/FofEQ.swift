import Foundation
import AVFoundation
import MediaToolbox

/// The equalizer: five bands applied to whatever the player is playing, through an audio tap on each song.
enum FofEQ {
    static let freqs: [Double] = [60, 250, 1000, 4000, 12000]
    static var gains: [Double] = [0, 0, 0, 0, 0] { didSet { version &+= 1 } }
    static var version = 0
    static var flat: Bool { gains.allSatisfy { abs($0) < 0.05 } }

    /// Hooks the equalizer onto a song once its audio track is known.
    static func attach(to item: AVPlayerItem) {
        let asset = item.asset
        Task {
            guard let track = try? await asset.loadTracks(withMediaType: .audio).first else { return }
            let ctx = TapContext()
            var cb = MTAudioProcessingTapCallbacks(
                version: kMTAudioProcessingTapCallbacksVersion_0,
                clientInfo: UnsafeMutableRawPointer(Unmanaged.passRetained(ctx).toOpaque()),
                init: tapInit, finalize: tapFinalize, prepare: tapPrepare, unprepare: nil, process: tapProcess)
            var made: Unmanaged<MTAudioProcessingTap>?
            guard MTAudioProcessingTapCreate(kCFAllocatorDefault, &cb, kMTAudioProcessingTapCreationFlag_PostEffects, &made) == noErr, let tap = made?.takeRetainedValue() else {
                Unmanaged<TapContext>.fromOpaque(cb.clientInfo!).release(); return
            }
            let params = AVMutableAudioMixInputParameters(track: track)
            params.audioTapProcessor = tap
            let mix = AVMutableAudioMix()
            mix.inputParameters = [params]
            await MainActor.run { item.audioMix = mix }
        }
    }
}

final class TapContext {
    var sampleRate: Double = 44100
    var ver = -1
    var coef: [[Double]] = []                 // per band: b0 b1 b2 a1 a2
    var z = [[Double]](repeating: [0, 0], count: 5 * 8) // per band and channel
    var pre: Float = 1

    func update() {
        ver = FofEQ.version
        coef = FofEQ.freqs.enumerated().map { (i, f) in
            let g = FofEQ.gains[i], A = pow(10, g / 40), w = 2 * Double.pi * min(f, sampleRate * 0.45) / sampleRate
            let alpha = sin(w) / (2 * 0.9), c = cos(w)
            let a0 = 1 + alpha / A
            return [(1 + alpha * A) / a0, (-2 * c) / a0, (1 - alpha * A) / a0, (-2 * c) / a0, (1 - alpha / A) / a0]
        }
        let boost = max(0, FofEQ.gains.max() ?? 0)
        pre = Float(pow(10, -boost * 0.6 / 20)) // leaves headroom so boosted bass doesn't crackle
    }

    func process(_ list: UnsafeMutablePointer<AudioBufferList>, frames: Int) {
        if FofEQ.flat { return }
        if ver != FofEQ.version { update() }
        let bufs = UnsafeMutableAudioBufferListPointer(list)
        var chBase = 0
        for buf in bufs {
            guard let raw = buf.mData else { continue }
            let nch = max(1, Int(buf.mNumberChannels))
            let s = raw.assumingMemoryBound(to: Float.self)
            for k in 0..<nch {
                let ch = min(chBase + k, 7)
                for n in 0..<frames {
                    let idx = n * nch + k
                    var x = Double(s[idx] * pre)
                    for b in 0..<5 {
                        let c = coef[b], zi = b * 8 + ch
                        let y = c[0] * x + z[zi][0]
                        z[zi][0] = c[1] * x - c[3] * y + z[zi][1]
                        z[zi][1] = c[2] * x - c[4] * y
                        x = y
                    }
                    s[idx] = Float(max(-1, min(1, x)))
                }
            }
            chBase += nch
        }
    }
}

private let tapInit: MTAudioProcessingTapInitCallback = { _, clientInfo, storageOut in
    storageOut.pointee = clientInfo
}
private let tapFinalize: MTAudioProcessingTapFinalizeCallback = { tap in
    Unmanaged<TapContext>.fromOpaque(MTAudioProcessingTapGetStorage(tap)).release()
}
private let tapPrepare: MTAudioProcessingTapPrepareCallback = { tap, _, format in
    let ctx = Unmanaged<TapContext>.fromOpaque(MTAudioProcessingTapGetStorage(tap)).takeUnretainedValue()
    ctx.sampleRate = format.pointee.mSampleRate > 0 ? format.pointee.mSampleRate : 44100
    ctx.ver = -1
    ctx.z = [[Double]](repeating: [0, 0], count: 5 * 8)
}
private let tapProcess: MTAudioProcessingTapProcessCallback = { tap, frames, _, list, framesOut, flagsOut in
    guard MTAudioProcessingTapGetSourceAudio(tap, frames, list, flagsOut, nil, framesOut) == noErr else { return }
    let ctx = Unmanaged<TapContext>.fromOpaque(MTAudioProcessingTapGetStorage(tap)).takeUnretainedValue()
    ctx.process(list, frames: Int(framesOut.pointee))
}
