# -*- coding: utf-8 -*-
"""提取 JS 视图中的所有 _('...') msgid，输出列表（供翻译用）"""
import re, glob, json, sys

ids = []
for f in sorted(glob.glob('*.js')):
    src = open(f, encoding='utf-8').read()
    for m in re.finditer(r"_\('((?:[^'\\]|\\.)*)'", src):
        s = m.group(1).replace("\\'", "'").replace('\\n', '\n')
        if s not in ids:
            ids.append(s)

out = {'count': len(ids), 'ids': ids}
json.dump(out, open('_msgids.json', 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
print('extracted', len(ids))
