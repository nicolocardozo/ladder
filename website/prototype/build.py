import re,sys
import os
R=os.path.join(os.path.dirname(os.path.abspath(__file__)),'..','..')+'/'
IC=R+'app/desktop/node_modules/@lobehub/icons-static-svg/icons/'
def clean(s):
    s=s.replace('#000000','currentColor')
    s=re.sub(r'\s(width|height)="[^"]*"','',s)
    s=re.sub(r'<title>.*?</title>','',s)
    s=re.sub(r'\sstyle="[^"]*"','',s)
    s=re.sub(r'\srole="img"|\saria-label="[^"]*"','',s)
    return s.strip().replace('<svg','<svg aria-hidden="true"',1)
logo=clean(open(R+'brand/logo/svg/ladder-horizontal-black.svg').read())
mark=clean(open(R+'brand/logo/svg/ladder-mark-black.svg').read())
A={k:clean(open(IC+f+'.svg').read()) for k,f in [('claude','claudecode'),('codex','codex'),('gemini','geminicli')]}
L={
'panel':'<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M9 3v18"/>',
'search':'<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
'pen':'<path d="M12 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.4 2.6a2.1 2.1 0 1 1 3 3L12 15l-4 1 1-4Z"/>',
'inbox':'<path d="M22 12h-6l-2 3h-4l-2-3H2"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/>',
'alert':'<circle cx="12" cy="12" r="10"/><path d="M12 8v4M12 16h.01"/>',
'folderplus':'<path d="M12 10v6M9 13h6"/><path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>',
'folder':'<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>',
'folderopen':'<path d="m6 14 1.5-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.54 6a2 2 0 0 1-1.95 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v2"/>',
'plus':'<path d="M12 5v14M5 12h14"/>',
'at':'<circle cx="12" cy="12" r="4"/><path d="M16 8v5a3 3 0 0 0 6 0v-1a10 10 0 1 0-4 8"/>',
'bars':'<path d="M6 20V14M12 20V4M18 20v-8"/>',
'shield':'<path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67 0C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/><path d="m9 12 2 2 4-4"/>',
'up':'<path d="M12 19V5M5 12l7-7 7 7"/>',
'check':'<path d="M20 6 9 17l-5-5"/>',
'file':'<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/>',
'term':'<path d="m4 17 6-6-6-6M12 19h8"/>',
'edit':'<path d="M12 20h9"/><path d="M16.4 3.6a2.1 2.1 0 1 1 3 3L7 19l-4 1 1-4Z"/>',
'bot':'<rect x="3" y="8" width="18" height="12" rx="2"/><path d="M12 8V4M8 14h.01M16 14h.01"/>',
'files':'<path d="M20 7h-3a2 2 0 0 1-2-2V2"/><path d="M9 18a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h7l4 4v10a2 2 0 0 1-2 2Z"/><path d="M3 7.6v12.8A1.6 1.6 0 0 0 4.6 22h9.8"/>',
'branch':'<circle cx="6" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="6" r="3"/><path d="M6 9v6M18 9a9 9 0 0 1-9 9"/>',
'gauge':'<path d="m12 14 4-4"/><path d="M3.34 19a10 10 0 1 1 17.32 0"/>',
'down':'<path d="M12 5v14M19 12l-7 7-7-7"/>',
'box':'<path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z"/><path d="m3.3 7 8.7 5 8.7-5M12 22V12"/>',
}
h=open(sys.argv[1]).read()
h=h.replace('%%LOGO%%',logo).replace('%%MARK%%',mark)
h=re.sub(r'%%A:(\w+)%%',lambda m:A[m.group(1)],h)
h=re.sub(r'%%I:(\w+)%%',lambda m:f'<svg class="i" viewBox="0 0 24 24" aria-hidden="true">{L[m.group(1)]}</svg>',h)
assert '%%' not in h, re.findall(r'%%[^%]+%%',h)
open(sys.argv[2],'w').write(h)
s=re.findall(r'<script>(.*?)</script>',h,re.S)[0]; open('/dev/null','w').write(s)
