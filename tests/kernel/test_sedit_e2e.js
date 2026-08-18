#!/usr/bin/env node
'use strict';
const {driveBoot}=require('./lib/drive.js');let fail=0;function ok(n,x,e=''){console.log((x?'  ok   ':'  FAIL ')+n+(x?'':' '+e));if(!x)fail++;}
const r=driveBoot([
 'printf "#include <stdio.h>\\nint main(void) {\\n  return 0;\\n}\\n" > /root/game.c',
 'printf "one\\ntwo\\n" > /root/other.c','printf "literal-colon\\n" > "/root/colon:name.c"',
 'sedit /root/game.c:3 &','wmctl wait label EDIT:0 12000','echo ==tree','wmctl tree','echo ==cut',
 'SID=$(wmctl list | grep "Source Editor$" | sed "s/[^0-9].*//")','wmctl key $SID 9 102 64','wmctl wait label "Find text:" 8000','echo ==findtree','wmctl tree','echo ==cut','wmctl click Cancel',
 'wmctl key $SID 9 103 64','for i in $(seq 1 80); do wmctl tree | grep -q "Line, FILE:LINE, or one cc diagnostic:" && break; sleep 0.1; done','wmctl settext EDIT:1 "/root/missing.c:8"','wmctl click Go','wmctl click OK','echo ==after-missing','wmctl gettext EDIT:0','wmctl gettext msctls_statusbar32:0','echo ==cut',
 'wmctl key $SID 9 103 64','for i in $(seq 1 80); do wmctl tree | grep -q "Line, FILE:LINE, or one cc diagnostic:" && break; sleep 0.1; done','wmctl settext EDIT:1 "/root/other.c:9"','wmctl click Go','wmctl click OK','echo ==after-eof','wmctl gettext EDIT:0','wmctl gettext msctls_statusbar32:0','echo ==cut',
 'wmctl gettext msctls_statusbar32:0','wmctl settext EDIT:0 "int main(void) { return 1; }"','wmctl click Save',
 'for i in $(seq 1 40); do grep -q "return 1" /root/game.c && break; sleep 0.05; done','echo ==file','cat /root/game.c','echo ==cut',
 'echo ==assoc','grep -E "^(c|h|default.gui|default.term)" /usr/share/openwith','echo ==cut',
 'echo ==menu','test -x "/usr/share/menu/Development/Source Editor" && echo MENU_OK','echo ==cut',
 'sedit /root/missing-cli.c:8 &','wmctl wait win "Source Editor - Open" 8000 && wmctl click OK && echo CLI-MISSING-LOUD',
 'sedit /root/other.c:9 &','wmctl wait label "location line 9 exceeds 3" 8000 && wmctl click OK && echo CLI-EOF-LOUD',
 'sedit "/root/colon:name.c" &','for i in $(seq 1 120); do wmctl tree | grep -q "literal-colon" && { echo CLI-LITERAL-COLON; break; }; sleep 0.1; done',
 'pkill sedit'
],{timeout:300000,maxBuffer:32*1024*1024});
const out=String(r.stdout);ok('sedit exits only after exercised boot',r.status===0,String(r.stderr));ok('stable editor and status controls',/class=EDIT id=100/.test(out)&&/class=msctls_statusbar32 id=101/.test(out));ok('CLI line navigation reports line 3',/Line 3/.test(out));const miss=(out.split('==after-missing\n')[1]||'').split('==cut')[0],eof=(out.split('==after-eof\n')[1]||'').split('==cut')[0];ok('Ctrl+G nonexistent path is loud and leaves document/caret atomic',miss.includes('return 0;')&&miss.includes('Line 3'),miss);ok('Ctrl+G beyond-EOF target leaves document/caret atomic',eof.includes('return 0;')&&eof.includes('Line 3'),eof);ok('CLI nonexistent and beyond-EOF locations are loud',out.includes('CLI-MISSING-LOUD')&&out.includes('CLI-EOF-LOUD'));ok('CLI existing literal-colon filename takes whole-path precedence',out.includes('CLI-LITERAL-COLON'));ok('edit and save changes bytes',/==file\nint main\(void\) \{ return 1; \}/.test(out));ok('c+h associations and defaults',/c\s+\/bin\/sedit/.test(out)&&/h\s+\/bin\/sedit/.test(out)&&/default\.gui\s+\/bin\/notepad/.test(out)&&/default\.term\s+vi/.test(out));ok('Development menu activation exists',/MENU_OK/.test(out));process.exit(fail?1:0);
