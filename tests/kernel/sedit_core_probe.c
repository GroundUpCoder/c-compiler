#define _POSIX_C_SOURCE 200809L
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <sys/stat.h>
#include "../../os/sedit/c_lex.h"
#include "../../os/sedit/document.h"

static int fail;
#define OK(n,x) do{if(x)printf("ok %s\n",n);else{printf("FAIL %s\n",n);fail++;}}while(0)
static int has(const SeditLexer*l,int k,const char*s,const char*src){for(size_t i=0;i<l->token_count;i++)if(l->tokens[i].kind==k&&l->tokens[i].end-l->tokens[i].start==strlen(s)&&!memcmp(src+l->tokens[i].start,s,strlen(s)))return 1;return 0;}
int main(int argc,char**argv){
 const char*src="#define OPEN { \\\n+  1\nint main(void) { /* } */ const char *s=\"{\"; return (2); }\n/* unterminated";
 SeditLexer l;sedit_lex_init(&l);OK("chunk1",sedit_lex_feed(&l,src,25));OK("chunk2",sedit_lex_feed(&l,src+25,strlen(src)-25));OK("finish",sedit_lex_finish(&l));OK("keyword",has(&l,SEDIT_T_KEYWORD,"return",src));OK("type",has(&l,SEDIT_T_TYPE,"int",src));OK("comment",has(&l,SEDIT_T_COMMENT,"/* } */",src));uint32_t m;int u;const char*brace=strstr(src,"main(void) {")+11;OK("normal brace paired",sedit_pair_mate(&l,(uint32_t)(brace-src),&m,&u)&&!u);OK("comment brace excluded",!sedit_pair_mate(&l,(uint32_t)(strstr(src,"/* } */")-src+3),&m,&u));sedit_lex_free(&l);
 char p[1024];uint32_t line;OK("arg location",!sedit_document_location("colon:name.c:42",p,sizeof p,&line)&&!strcmp(p,"colon:name.c")&&line==42);OK("primary diagnostic",!sedit_document_diagnostic("colon:name.c:9: error: bad",p,sizeof p,&line)&&line==9);OK("link diagnostic",!sedit_document_diagnostic("  at colon:name.c:7",p,sizeof p,&line)&&line==7);OK("reject column",sedit_document_diagnostic("a.c:2:3: error: bad",p,sizeof p,&line)!=0);
 if(argc<2)return 2;char f[1024],linkp[1024],hard[1024];snprintf(f,sizeof f,"%s/a.c",argv[1]);snprintf(linkp,sizeof linkp,"%s/l.c",argv[1]);snprintf(hard,sizeof hard,"%s/h.c",argv[1]);FILE*fp=fopen(f,"wb");fwrite("a\r\nb\r\n",1,6,fp);fclose(fp);symlink("a.c",linkp);SeditDocument d;sedit_document_init(&d);OK("load symlink",!sedit_document_load(&d,linkp));OK("CRLF detected",d.eol==SEDIT_EOL_CRLF);OK("physical target",strstr(d.target_path,"/a.c")!=NULL);OK("atomic save",sedit_document_save(&d,NULL,"a\nbb\n",5,0,0)==SEDIT_SAVE_OK);char b[32]={0};fp=fopen(f,"rb");size_t n=fread(b,1,sizeof b,fp);fclose(fp);OK("CRLF preserved",n==7&&!memcmp(b,"a\r\nbb\r\n",7));OK("symlink preserved",lstat(linkp,&d.opened_stat)==0&&S_ISLNK(d.opened_stat.st_mode));
 fp=fopen(f,"wb");fwrite("external",1,8,fp);fclose(fp);OK("hash conflict",sedit_document_save(&d,NULL,"mine",4,0,0)==SEDIT_SAVE_CONFLICT);sedit_document_free(&d);sedit_document_init(&d);OK("reload",!sedit_document_load(&d,f));link(f,hard);OK("hardlink refusal",sedit_document_save(&d,NULL,"new",3,0,0)==SEDIT_SAVE_HARDLINK);OK("explicit break",sedit_document_save(&d,NULL,"new",3,0,1)==SEDIT_SAVE_OK);struct stat a,h;stat(f,&a);stat(hard,&h);OK("break retained peer",a.st_ino!=h.st_ino);sedit_document_free(&d);
 return fail?1:0;
}
