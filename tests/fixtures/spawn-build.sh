mkdir -p /root/spawn-build || exit $?
cd /root/spawn-build || exit $?
# A real multi-module build: every generated module is referenced, so losing
# one cannot silently produce a successful link of a partial source glob.
printf '#include <stdio.h>\n' > main.c || exit $?
printf 'int main(void) { int sum = 0;\n' > body.txt || exit $?
i=0
while [ $i -lt 40 ]; do
  printf 'int m%s(void) { return 45 * %s; }\n' "$i" "$i" > m$i.c || exit $?
  printf 'int m%s(void);\n' "$i" >> main.c || exit $?
  printf 'sum += m%s();\n' "$i" >> body.txt || exit $?
  wc -c m$i.c > /dev/null || exit $?
  i=$(expr $i + 1) || exit $?
done
printf 'printf("TOTAL=%%d\\n",sum); return sum != 35100; }\n' >> body.txt || exit $?
cat body.txt >> main.c || exit $?
cc *.c -o app || exit $?
./app || exit $?
