"""Наложить правильный текст (Genius) на тайминги Whisper.

Стратегия: где Whisper услышал верно — сохраняем точные word-timings,
заменяя только текст токенов 1:1. Где текст неверный или сегмент
склеен из нескольких строк — делим время равномерно.
Плюс добавляем пропущенное интро (0-9с, видно по энергии вокала).
"""
import json
from pathlib import Path

TRACK = Path('output/htdemucs/Серега Пират - Прости я не знаю')
WEB_LYRICS = Path('web/public/songs/serega-pirat-prosti-ya-ne-znayu/lyrics.json')

src = json.loads((TRACK / 'vocals_lyrics.json').read_text(encoding='utf-8'))
OLD = src['segments']


def even(words, s, e):
    n = len(words)
    out = []
    for i, w in enumerate(words):
        ws = round(s + (e - s) * i / n, 2)
        we = round(s + (e - s) * (i + 1) / n, 2)
        out.append({'w': w, 's': ws, 'e': we})
    return out


def retoken(old_words, new_tokens):
    """Замена текста 1:1 с сохранением таймингов."""
    assert len(old_words) == len(new_tokens), (len(old_words), new_tokens)
    out = []
    for ow, nw in zip(old_words, new_tokens):
        d = {'w': nw, 's': ow['s'], 'e': ow['e']}
        if 'p' in ow:
            d['p'] = ow['p']
        out.append(d)
    return out


def seg(s, e, text, words, part):
    return {'start': s, 'end': e, 'text': text, 'words': words, 'part': part}


o = OLD
N = []

# --- Интро (Whisper пропустил, энергия вокала 1.2-7.4с) ---
N.append(seg(1.20, 3.20, 'Представь их ебло', even(['Представь', 'их', 'ебло'], 1.20, 3.20), 'Интро'))
N.append(seg(3.60, 5.20, 'Представь их ебло', even(['Представь', 'их', 'ебло'], 3.60, 5.20), 'Интро'))
N.append(seg(5.40, 6.60, 'Представь их ебло', even(['Представь', 'их', 'ебло'], 5.40, 6.60), 'Интро'))
N.append(seg(6.60, 7.40, 'Представь их еб…', even(['Представь', 'их', 'еб…'], 6.60, 7.40), 'Интро'))

# --- Куплет 1 ---
N.append(seg(o[0]['start'], o[0]['end'], 'LOL, пожалуйста, прости, но мне уже пора идти',
             retoken(o[0]['words'], ['LOL,', 'пожалуйста,', 'прости,', 'но', 'мне', 'уже', 'пора', 'идти']), 'Куплет 1'))
N.append(seg(o[1]['start'], o[1]['end'], o[1]['text'], o[1]['words'], 'Куплет 1'))
N.append(seg(o[2]['start'], o[2]['end'], 'И делать вайб (Е), всем раздавать',
             even(['И', 'делать', 'вайб', '(Е),', 'всем', 'раздавать'], o[2]['start'], o[2]['end']), 'Куплет 1'))
N.append(seg(o[3]['start'], o[3]['end'], 'Сорри, goodbye (Е), мне поебать',
             even(['Сорри,', 'goodbye', '(Е),', 'мне', 'поебать'], o[3]['start'], o[3]['end']), 'Куплет 1'))

# --- Предприпев 1 (сегмент 4 был склейкой) ---
N.append(seg(28.03, 30.10, 'Сорри, goodbye, мне поебать',
             even(['Сорри,', 'goodbye,', 'мне', 'поебать'], 28.03, 30.10), 'Предприпев'))
N.append(seg(30.10, 35.00, 'Сорри, goodbye',
             even(['Сорри,', 'goodbye'], 30.10, 35.00), 'Предприпев'))

# --- Припев 1 ---
w4 = [{'w': 'Прости,', 's': 37.50, 'e': 38.05}] + o[4]['words'][1:]
N.append(seg(37.50, 41.01, 'Прости, я не знаю, никто не знает тебя', w4, 'Припев'))
N.append(seg(o[5]['start'], o[5]['end'], 'Смотри, я сияю — это мечта большинства',
             retoken(o[5]['words'], ['Смотри,', 'я', 'сияю', '—', 'это', 'мечта', 'большинства']), 'Припев'))
N.append(seg(o[6]['start'], o[6]['end'], 'Они называли меня мудак и еблан',
             retoken(o[6]['words'], ['Они', 'называли', 'меня', 'мудак', 'и', 'еблан']), 'Припев'))
N.append(seg(o[7]['start'], o[7]['end'], 'Sunshine, beautiful life',
             retoken(o[7]['words'], ['Sunshine,', 'beautiful', 'life']), 'Припев'))

# --- Постприпев ---
N.append(seg(o[8]['start'], o[8]['end'], 'Sunshine, beautiful life',
             retoken(o[8]['words'], ['Sunshine,', 'beautiful', 'life']), 'Постприпев'))
N.append(seg(o[9]['start'], o[9]['end'], 'Sunshine, оу-е',
             [{'w': 'Sunshine, оу-е', 's': o[9]['words'][0]['s'], 'e': o[9]['words'][0]['e']}], 'Постприпев'))

# --- Куплет 2 ---
N.append(seg(o[10]['start'], o[10]['end'], o[10]['text'], o[10]['words'], 'Куплет 2'))
w11 = o[11]['words']
merged = w11[:4] + [{'w': 'как-то', 's': w11[4]['s'], 'e': w11[5]['e']}] + [
    {'w': 'жёстко', 's': w11[6]['s'], 'e': w11[6]['e']},
    {'w': 'положил (—жил)', 's': w11[7]['s'], 'e': w11[7]['e']}]
N.append(seg(o[11]['start'], o[11]['end'], 'На твои проблемы я как-то жёстко положил (—жил)', merged, 'Куплет 2'))
N.append(seg(o[12]['start'], o[12]['end'], 'И даже поржал (Вуп), не поддержал (Вуп)',
             even(['И', 'даже', 'поржал', '(Вуп),', 'не', 'поддержал', '(Вуп)'], o[12]['start'], o[12]['end']), 'Куплет 2'))
N.append(seg(o[13]['start'], o[13]['end'], 'Мне правда жаль (Вуп), я побежал',
             even(['Мне', 'правда', 'жаль', '(Вуп),', 'я', 'побежал'], o[13]['start'], o[13]['end']), 'Куплет 2'))

# --- Предприпев 2 (сегмент 14 был склейкой) ---
N.append(seg(82.23, 84.00, 'Мне правда жаль, я побежал',
             even(['Мне', 'правда', 'жаль,', 'я', 'побежал'], 82.23, 84.00), 'Предприпев'))
N.append(seg(84.00, 91.50, 'Мне правда жаль, е',
             even(['Мне', 'правда', 'жаль,', 'е'], 84.00, 91.50), 'Предприпев'))

# --- Припев 2 ---
w14 = [{'w': 'Прости,', 's': 91.80, 'e': 92.36}] + o[14]['words'][1:]
N.append(seg(91.80, 95.54, 'Прости, я не знаю, никто не знает тебя', w14, 'Припев'))
N.append(seg(o[15]['start'], o[15]['end'], 'Смотри, я сияю — это мечта большинства',
             retoken(o[15]['words'], ['Смотри,', 'я', 'сияю', '—', 'это', 'мечта', 'большинства']), 'Припев'))
N.append(seg(o[16]['start'], o[16]['end'], 'Они называли меня мудак и еблан',
             retoken(o[16]['words'], ['Они', 'называли', 'меня', 'мудак', 'и', 'еблан']), 'Припев'))
N.append(seg(o[17]['start'], o[17]['end'], 'Никто не верил, но я жёстко разъебал',
             retoken(o[17]['words'], ['Никто', 'не', 'верил,', 'но', 'я', 'жёстко', 'разъебал']), 'Припев'))


def outro_line(oi, text):
    return seg(o[oi]['start'], o[oi]['end'], text,
               retoken(o[oi]['words'], text.split(' ')) if len(o[oi]['words']) == len(text.split(' '))
               else even(text.split(' '), o[oi]['start'], o[oi]['end']), 'Аутро')


# --- Аутро ---
N.append(seg(o[18]['start'], o[18]['end'], '(Вау)', [{'w': '(Вау)', 's': o[18]['words'][0]['s'], 'e': o[18]['words'][0]['e']}], 'Аутро'))
N.append(outro_line(19, 'Но я жёстко разъебал'))
N.append(seg(o[20]['start'], o[20]['end'], '(Вау)', [{'w': '(Вау)', 's': o[20]['words'][0]['s'], 'e': o[20]['words'][0]['e']}], 'Аутро'))
N.append(outro_line(21, 'Но я жёстко разъебал'))
N.append(seg(o[22]['start'], o[22]['end'], '(Вау)', [{'w': '(Вау)', 's': o[22]['words'][0]['s'], 'e': o[22]['words'][0]['e']}], 'Аутро'))
N.append(outro_line(23, 'Но я жёстко разъебал'))
N.append(seg(o[24]['start'], o[24]['end'], '(Вау)', [{'w': '(Вау)', 's': o[24]['words'][0]['s'], 'e': o[24]['words'][0]['e']}], 'Аутро'))
N.append(outro_line(25, 'Но я жёстко разъебал'))

print(f'сегментов: {len(OLD)} -> {len(N)}')

# 1. бандл пайплайна (источник правды)
bundle_lyr = {'audio': src.get('audio'), 'language': 'ru', 'segments': N}
(TRACK / 'vocals_lyrics.json').write_text(json.dumps(bundle_lyr, ensure_ascii=False, indent=1), encoding='utf-8')
kb = json.loads((TRACK / 'karaoke.json').read_text(encoding='utf-8'))
kb['lyrics'] = bundle_lyr
(TRACK / 'karaoke.json').write_text(json.dumps(kb, ensure_ascii=False, indent=1), encoding='utf-8')

# 2. веб-каталог (без служебных полей)
web = {'language': 'ru', 'segments': [
    {'start': s['start'], 'end': s['end'], 'text': s['text'], 'part': s.get('part'),
     'words': [{'w': w['w'], 's': w['s'], 'e': w['e']} for w in s['words']]} for s in N]}
WEB_LYRICS.write_text(json.dumps(web, ensure_ascii=False), encoding='utf-8')

# 3. обновить счётчик строк в манифесте
mp = WEB_LYRICS.parent.parent / 'manifest.json'
m = json.loads(mp.read_text(encoding='utf-8'))
for s in m['songs']:
    if s['id'] == 'serega-pirat-prosti-ya-ne-znayu':
        s['lines'] = len(N)
mp.write_text(json.dumps(m, ensure_ascii=False, indent=1), encoding='utf-8')
print('OK: bundle + web обновлены')
