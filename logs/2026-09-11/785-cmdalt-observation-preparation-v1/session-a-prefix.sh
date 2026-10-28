echo ==nopython
python /root/whatever.py 2>&1; echo RC=$?
echo ==cut
echo ==baked
grep -v "^#" /usr/share/cmdalt
echo ==cut
ln -s /usr/bin/cmdalt /usr/local/bin/foo
ln -s /usr/bin/cmdalt /usr/local/bin/bar
cmdalt set foo /bin/echo
echo ==argv
foo a b
foo --help
foo -c --version -
echo ==cut
cmdalt set bar /bin/pwd
echo ==two
cd /root; bar
foo still-echo
echo ==cut
cmdalt set foo /bin/sh
echo ==status
foo -c "exit 3"; echo RC=$?
foo -c 'kill -TERM $$'; echo SIG=$?
echo ==cut
echo ==missing
cmdalt set foo nosuchprog
foo x 2>&1; echo RC=$?
echo ==cut
printf 'foo\t/bin/echo\n' > /etc/cmdalt
echo ==missing2
foo x 2>&1; echo RC=$?
echo ==cut
echo ==layers
cmdalt reset foo
foo etc-layer
cmdalt set foo /bin/pwd
cd /tmp; foo
cmdalt reset foo
cd /root; foo etc-again
echo ==cut
rm -f /etc/cmdalt
cmdalt set foo /bin/echo
printf '#!/usr/local/bin/foo\n' > /root/script.sh
chmod 755 /root/script.sh
echo ==shebang
/root/script.sh tail-arg
echo ==cut
echo ==selfdispatch
cmdalt set foo foo
foo boom 2>&1; echo RC=$?
echo ==cut
cmdalt set foo /bin/echo
echo ==list
cmdalt list
echo ==cut
echo ==which
cmdalt which foo
echo ==cut
printf '#!/bin/sh\necho SHADOW-RAN\n' > /usr/local/bin/python
chmod 755 /usr/local/bin/python
