# The "director": prepares text the way a narrator would read it — pronunciations, numbers and pauses.
import re
ROMAN = {'I': 1, 'II': 2, 'III': 3, 'IV': 4, 'V': 5, 'VI': 6, 'VII': 7, 'VIII': 8, 'IX': 9, 'X': 10, 'XI': 11, 'XII': 12, 'XIII': 13, 'XIV': 14, 'XV': 15, 'XVI': 16, 'XVII': 17, 'XVIII': 18}
ORD = ['', 'First', 'Second', 'Third', 'Fourth', 'Fifth', 'Sixth', 'Seventh', 'Eighth', 'Ninth', 'Tenth', 'Eleventh', 'Twelfth', 'Thirteenth', 'Fourteenth', 'Fifteenth', 'Sixteenth', 'Seventeenth', 'Eighteenth']
ONES = 'zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen'.split()
TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety']
def words(n):
    if n < 20: return ONES[n]
    if n < 100: return TENS[n // 10] + ('-' + ONES[n % 10] if n % 10 else '')
    if n < 1000: return ONES[n // 100] + ' hundred' + (' ' + words(n % 100) if n % 100 else '')
    return str(n)
def year(n):
    if 1100 <= n <= 1999 or 2010 <= n <= 2099: return words(n // 100) + ' ' + (('oh ' + ONES[n % 100]) if 0 < n % 100 < 10 else words(n % 100) if n % 100 else 'hundred')
    if 2000 <= n <= 2009: return 'two thousand' + (' ' + ONES[n % 10] if n % 10 else '')
    return str(n)
FIX = {r'\bMr\.': 'Mister', r'\bMrs\.': 'Missus', r'\bDr\.': 'Doctor', r'\bSt\. (?=[A-Z])': 'Saint ', r'\be\.g\.': 'for example', r'\bi\.e\.': 'that is',
       r'\betc\.': 'et cetera', r'\bvs\.?': 'versus', r'&': ' and ', r'%': ' percent', r'\bB\.C\.': 'B.C.', r'\bA\.D\.': 'A.D.'}
def direct(t):
    t = re.sub(r'\b([A-Z][a-z]+) (X{0,3}(?:IX|IV|V?I{0,3}))\b', lambda m: f'{m.group(1)} the {ORD[ROMAN[m.group(2)]]}' if m.group(2) in ROMAN and m.group(1) in KINGS else m.group(0), t)
    t = re.sub(r'\b(Law|Chapter|Part|Book|Rule|Lesson|Step) (\d{1,3})\b', lambda m: f'{m.group(1)} {words(int(m.group(2))).title()}', t)
    t = re.sub(r'\b(1[1-9]\d\d|20\d\d)s\b', lambda m: year(int(m.group(1))) + 's', t)
    t = re.sub(r'\b(in|of|by|since|until|from|to|year|around|circa|c\.) (1[1-9]\d\d|20\d\d)\b', lambda m: f'{m.group(1)} {year(int(m.group(2)))}', t)
    for k, v in FIX.items(): t = re.sub(k, v, t)
    t = re.sub(r'\s*[—–]\s*', ', ', t)                # dashes read as a short breath
    t = re.sub(r'\s*\.\.\.\s*|…', '... ', t)            # ellipses: a held pause
    t = re.sub(r'([A-Za-z])\*+([a-z])', lambda m: m.group(1) + {'f': 'uc', 's': 'hi'}.get(m.group(1).lower(), '') + m.group(2), t)
    t = re.sub(r'[\[\]{}*_#<>|~^]', '', t)
    return re.sub(r'[ \t]+', ' ', t).strip()
KINGS = {'Louis', 'Henry', 'Charles', 'Elizabeth', 'George', 'Edward', 'William', 'Richard', 'James', 'Philip', 'Frederick', 'Napoleon', 'Pope', 'Peter', 'Ivan', 'Alexander', 'Leo', 'Pius', 'Gregory', 'John', 'Mary', 'Catherine', 'Ferdinand', 'Francis'}
