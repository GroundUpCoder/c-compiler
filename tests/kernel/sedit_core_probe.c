#define _POSIX_C_SOURCE 200809L
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <sys/stat.h>
#include <errno.h>
#include <fcntl.h>
#include "../../os/sedit/c_lex.h"
#include "../../os/sedit/document.h"
#include "../../os/sha256.h"

static int fail;
#define OK(n,x) do{if(x)printf("ok %s\n",n);else{printf("FAIL %s\n",n);fail++;}}while(0)
static int has(const SeditLexer*l,int k,const char*s,const char*src){for(size_t i=0;i<l->token_count;i++)if(l->tokens[i].kind==k&&l->tokens[i].end-l->tokens[i].start==strlen(s)&&!memcmp(src+l->tokens[i].start,s,strlen(s)))return 1;return 0;}
static int lex_equal(const SeditLexer*a,const SeditLexer*b){return a->token_count==b->token_count&&a->pair_count==b->pair_count&&!memcmp(a->tokens,b->tokens,a->token_count*sizeof(*a->tokens))&&!memcmp(a->pairs,b->pairs,a->pair_count*sizeof(*a->pairs));}
#ifdef SEDIT_TEST
static int fault,eintr_once,unlinks;
static int t_open(const char*p,int f,mode_t m){if(fault==1&&(f&O_WRONLY)){errno=ENOSPC;return-1;}return open(p,f,m);}
static ssize_t t_write(int fd,const void*b,size_t n){if(fault==2){errno=ENOSPC;return-1;}if(fault==3&&eintr_once++==0){errno=EINTR;return-1;}if(fault==4&&n>1)n=1;return write(fd,b,n);}
static int t_chmod(int fd,mode_t m){if(fault==5){errno=EPERM;return-1;}return fchmod(fd,m);}
static int t_fsync(int fd){if(fault==6){errno=ENOSPC;return-1;}return fsync(fd);}
static int t_close(int fd){int r=close(fd);if(fault==7){errno=EIO;return-1;}return r;}
static int t_rename(const char*a,const char*b){if(fault==8){errno=EACCES;return-1;}return rename(a,b);}
static int t_unlink(const char*p){unlinks++;return unlink(p);}
static int t_sha(const char*p,char h[65]){if(fault==9){errno=EIO;return-1;}return sha256_path(p,h);}
static void set_fault(int f){SeditIOOps o={0};fault=f;eintr_once=0;unlinks=0;o.open_fn=t_open;o.write_fn=t_write;o.fchmod_fn=t_chmod;o.fsync_fn=t_fsync;o.close_fn=t_close;o.rename_fn=t_rename;o.unlink_fn=t_unlink;o.sha256_path_fn=t_sha;sedit_document_test_io(&o);}
#endif
int main(int argc,char**argv){
 const char*src="#define OPEN { \\\n+  1\nint main(void) { /* } */ const char *s=\"{\"; return (2); }\n/* unterminated";
 SeditLexer l;sedit_lex_init(&l);OK("chunk1",sedit_lex_feed(&l,src,25));OK("chunk2",sedit_lex_feed(&l,src+25,strlen(src)-25));OK("finish",sedit_lex_finish(&l));OK("keyword",has(&l,SEDIT_T_KEYWORD,"return",src));OK("type",has(&l,SEDIT_T_TYPE,"int",src));OK("comment",has(&l,SEDIT_T_COMMENT,"/* } */",src));uint32_t m;int u;const char*brace=strstr(src,"main(void) {")+11;OK("normal brace paired",sedit_pair_mate(&l,(uint32_t)(brace-src),&m,&u)&&!u);OK("comment brace excluded",!sedit_pair_mate(&l,(uint32_t)(strstr(src,"/* } */")-src+3),&m,&u));sedit_lex_free(&l);
 const char*boundary="int café=.12; /* split */ return (café); // tail\n";SeditLexer whole;sedit_lex_init(&whole);sedit_lex_feed(&whole,boundary,strlen(boundary));sedit_lex_finish(&whole);int allsplit=1;for(size_t cut=0;cut<=strlen(boundary);cut++){SeditLexer q;sedit_lex_init(&q);if(!sedit_lex_feed(&q,boundary,cut)||!sedit_lex_feed(&q,boundary+cut,strlen(boundary)-cut)||!sedit_lex_finish(&q)||!lex_equal(&whole,&q))allsplit=0;sedit_lex_free(&q);}OK("every split boundary is invisible",allsplit);OK("split witness keyword",has(&whole,SEDIT_T_KEYWORD,"return",boundary));OK("split witness block comment",has(&whole,SEDIT_T_COMMENT,"/* split */",boundary));sedit_lex_free(&whole);
 char random_src[8192];size_t rw=0;const char*atoms[]={"int ","x=.5;","/* [ ] */","return ","(x);","// }\n","\"{utf8-é}\";","#define Q(x) \\\n (x)\n"};unsigned seed=718;for(int ri=0;ri<200;ri++){seed=seed*1664525u+1013904223u;const char*a0=atoms[seed%8];size_t an=strlen(a0);if(rw+an<sizeof random_src){memcpy(random_src+rw,a0,an);rw+=an;}}SeditLexer oracle;sedit_lex_init(&oracle);sedit_lex_feed(&oracle,random_src,rw);sedit_lex_finish(&oracle);int random_ok=1;for(int trial=0;trial<64;trial++){SeditLexer q;sedit_lex_init(&q);size_t at=0;while(at<rw){seed=seed*1664525u+1013904223u;size_t z=1+seed%47;if(z>rw-at)z=rw-at;if(!sedit_lex_feed(&q,random_src+at,z))random_ok=0;at+=z;}if(!sedit_lex_finish(&q)||!lex_equal(&oracle,&q))random_ok=0;sedit_lex_free(&q);}OK("randomized split schedules equal independent one-feed oracle",random_ok);sedit_lex_free(&oracle);
 char p[1024];uint32_t line;OK("arg location",!sedit_document_location("colon:name.c:42",p,sizeof p,&line)&&!strcmp(p,"colon:name.c")&&line==42);OK("primary diagnostic",!sedit_document_diagnostic("colon:name.c:9: error: bad",p,sizeof p,&line)&&line==9);OK("link diagnostic",!sedit_document_diagnostic("  at colon:name.c:7",p,sizeof p,&line)&&line==7);OK("reject column",sedit_document_diagnostic("a.c:2:3: error: bad",p,sizeof p,&line)!=0);
 OK("reject zero line",sedit_document_location("a.c:0",p,sizeof p,&line)!=0);OK("reject overflow line",sedit_document_location("a.c:4294967296",p,sizeof p,&line)!=0);OK("reject multiline diagnostic",sedit_document_diagnostic("a.c:2: error: x\nmore",p,sizeof p,&line)!=0);OK("reject unrelated text",sedit_document_diagnostic("a.c:2: note: x",p,sizeof p,&line)!=0);
 if(argc<2)return 2;char f[1024],f2[1024],linkp[1024],hard[1024];snprintf(f,sizeof f,"%s/a.c",argv[1]);snprintf(f2,sizeof f2,"%s/b.c",argv[1]);snprintf(linkp,sizeof linkp,"%s/l.c",argv[1]);snprintf(hard,sizeof hard,"%s/h.c",argv[1]);FILE*fp=fopen(f,"wb");fwrite("a\r\nb\r\n",1,6,fp);fclose(fp);symlink("a.c",linkp);SeditDocument d;sedit_document_init(&d);OK("load symlink",!sedit_document_load(&d,linkp));OK("CRLF detected",d.eol==SEDIT_EOL_CRLF);OK("physical target",strstr(d.target_path,"/a.c")!=NULL);OK("atomic save",sedit_document_save(&d,NULL,"a\nbb\n",5,0,0)==SEDIT_SAVE_OK);char b[32]={0};fp=fopen(f,"rb");size_t n=fread(b,1,sizeof b,fp);fclose(fp);OK("CRLF preserved",n==7&&!memcmp(b,"a\r\nbb\r\n",7));OK("symlink preserved",lstat(linkp,&d.opened_stat)==0&&S_ISLNK(d.opened_stat.st_mode));
 stat(f,&d.opened_stat);fp=fopen(f2,"wb");fwrite("other",1,5,fp);fclose(fp);unlink(linkp);symlink("b.c",linkp);OK("symlink retarget is conflict",sedit_document_save(&d,NULL,"mine",4,0,0)==SEDIT_SAVE_CONFLICT);memset(b,0,sizeof b);fp=fopen(f,"rb");n=fread(b,1,sizeof b,fp);fclose(fp);OK("retarget conflict preserves old physical target",n==7&&!memcmp(b,"a\r\nbb\r\n",7));fp=fopen(f2,"rb");n=fread(b,1,sizeof b,fp);fclose(fp);OK("retarget conflict preserves new physical target",n==5&&!memcmp(b,"other",5));unlink(linkp);symlink("a.c",linkp);
#ifdef SEDIT_TEST
 set_fault(3);OK("write EINTR is retried",sedit_document_save(&d,NULL,"a\nbb\n",5,0,0)==SEDIT_SAVE_OK);set_fault(4);OK("short writes complete",sedit_document_save(&d,NULL,"a\nbb\n",5,0,0)==SEDIT_SAVE_OK);int stages[]={1,2,5,6,7,8};const char*names[]={"create ENOSPC","write ENOSPC","chmod failure","fsync failure","close failure","rename failure"};for(size_t si=0;si<sizeof stages/sizeof stages[0];si++){set_fault(stages[si]);OK(names[si],sedit_document_save(&d,NULL,"changed",7,0,0)==SEDIT_SAVE_ERROR);if(stages[si]>=2)OK("failed save attempts cleanup",unlinks>0);}sedit_document_test_io(NULL);
#endif
 fp=fopen(f,"wb");fwrite("external",1,8,fp);fclose(fp);OK("hash conflict",sedit_document_save(&d,NULL,"mine",4,0,0)==SEDIT_SAVE_CONFLICT);sedit_document_free(&d);sedit_document_init(&d);OK("reload",!sedit_document_load(&d,f));link(f,hard);OK("hardlink refusal",sedit_document_save(&d,NULL,"new",3,0,0)==SEDIT_SAVE_HARDLINK);OK("explicit break",sedit_document_save(&d,NULL,"new",3,0,1)==SEDIT_SAVE_OK);struct stat a,h;stat(f,&a);stat(hard,&h);OK("break retained peer",a.st_ino!=h.st_ino);sedit_document_free(&d);
 fp=fopen(f2,"wb");fwrite("\xef\xbb\xbf" "a\r\nb\rc\nz",1,11,fp);fclose(fp);sedit_document_init(&d);OK("mixed EOL plus BOM loads",!sedit_document_load(&d,f2)&&d.eol==SEDIT_EOL_MIXED&&d.bom);OK("explicit EOL choice",!sedit_document_set_eol(&d,SEDIT_EOL_CR));OK("BOM and no-final-newline save",sedit_document_save(&d,NULL,d.text,d.len,0,0)==SEDIT_SAVE_OK);memset(b,0,sizeof b);fp=fopen(f2,"rb");n=fread(b,1,sizeof b,fp);fclose(fp);OK("chosen CR encoding exact",n==10&&!memcmp(b,"\xef\xbb\xbf" "a\rb\rc\rz",10));sedit_document_free(&d);
 return fail?1:0;
}
