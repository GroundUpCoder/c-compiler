#define _POSIX_C_SOURCE 200809L
#include "document.h"
#include "../sha256.h"
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

static void err(SeditDocument*d,const char*op,const char*p){snprintf(d->error,sizeof d->error,"%s '%s': %s",op,p?p:"",strerror(errno));}
void sedit_document_init(SeditDocument*d){memset(d,0,sizeof(*d));d->eol=SEDIT_EOL_LF;}
void sedit_document_free(SeditDocument*d){free(d->text);d->text=NULL;d->len=0;}
int sedit_document_new(SeditDocument*d){sedit_document_free(d);memset(d,0,sizeof(*d));d->text=strdup("");d->eol=SEDIT_EOL_LF;return d->text?0:-1;}
static int utf8ok(const unsigned char*s,size_t n){for(size_t i=0;i<n;){unsigned c=s[i],need=0,min=0;if(c<0x80){if(!c)return 0;i++;continue;}if((c&0xe0)==0xc0){need=1;min=0x80;c&=31;}else if((c&0xf0)==0xe0){need=2;min=0x800;c&=15;}else if((c&0xf8)==0xf0){need=3;min=0x10000;c&=7;}else return 0;if(i+need>=n)return 0;for(unsigned k=0;k<need;k++){unsigned q=s[++i];if((q&0xc0)!=0x80)return 0;c=(c<<6)|(q&63);}if(c<min||c>0x10ffff||(c>=0xd800&&c<=0xdfff))return 0;i++;}return 1;}
int sedit_document_load(SeditDocument*d,const char*path){
    struct stat st;if(lstat(path,&st)||(!S_ISREG(st.st_mode)&&!S_ISLNK(st.st_mode))){if(!errno)errno=EINVAL;err(d,"open",path);return -1;}
    char real[sizeof d->target_path];if(!realpath(path,real)){err(d,"realpath",path);return -1;}if(stat(real,&st)||!S_ISREG(st.st_mode)){errno=EINVAL;err(d,"regular file required",real);return -1;}if((uint64_t)st.st_size>SEDIT_MAX_FILE){errno=EFBIG;err(d,"file exceeds 8 MiB",real);return -1;}
    int fd=open(real,O_RDONLY);if(fd<0){err(d,"open",real);return -1;}size_t n=(size_t)st.st_size;unsigned char*b=malloc(n+1);if(!b){close(fd);errno=ENOMEM;err(d,"allocate",real);return -1;}size_t o=0;while(o<n){ssize_t r=read(fd,b+o,n-o);if(r<0&&errno==EINTR)continue;if(r<=0){int e=r<0?errno:EIO;free(b);close(fd);errno=e;err(d,"read",real);return -1;}o+=(size_t)r;}close(fd);b[n]=0;
    int bom=n>=3&&!memcmp(b,"\xef\xbb\xbf",3);size_t z=bom?3:0;if(!utf8ok(b+z,n-z)){free(b);errno=EILSEQ;err(d,"valid UTF-8 required",real);return -1;}
    size_t crlf=0,lf=0,cr=0,outn=0;for(size_t i=z;i<n;i++){if(b[i]=='\r'){if(i+1<n&&b[i+1]=='\n'){crlf++;i++;}else cr++;outn++;}else{if(b[i]=='\n')lf++;outn++;}}
    char*out=malloc(outn+1);if(!out){free(b);errno=ENOMEM;err(d,"allocate",real);return -1;}size_t w=0;for(size_t i=z;i<n;i++){if(b[i]=='\r'){if(i+1<n&&b[i+1]=='\n')i++;out[w++]='\n';}else out[w++]=(char)b[i];}out[w]=0;
    enum SeditEol e=SEDIT_EOL_LF;int kinds=(crlf>0)+(lf>0)+(cr>0);if(kinds>1)e=SEDIT_EOL_MIXED;else if(crlf)e=SEDIT_EOL_CRLF;else if(cr)e=SEDIT_EOL_CR;
    sedit_document_free(d);d->text=out;d->len=w;d->eol=e;d->bom=bom;d->dirty=0;snprintf(d->user_path,sizeof d->user_path,"%s",path);snprintf(d->target_path,sizeof d->target_path,"%s",real);d->opened_stat=st;sha256_of(b,n,d->opened_hash);d->have_snapshot=1;d->error[0]=0;free(b);return 0;
}
int sedit_document_set_eol(SeditDocument*d,enum SeditEol e){if(e<SEDIT_EOL_LF||e>SEDIT_EOL_CR)return-1;d->eol=e;return 0;}
int sedit_document_location(const char*a,char*p,size_t cap,uint32_t*line){if(!a||!p||cap<2||strchr(a,'\n')||strchr(a,'\0')!=a+strlen(a))return-1;struct stat st;if(!lstat(a,&st)){snprintf(p,cap,"%s",a);*line=1;return 0;}const char*c=strrchr(a,':');if(!c||c==a||!c[1])return-1;uint64_t v=0;for(const char*q=c+1;*q;q++){if(*q<'0'||*q>'9')return-1;v=v*10+(unsigned)(*q-'0');if(v>UINT32_MAX)return-1;}if(!v||((size_t)(c-a)>=cap))return-1;memcpy(p,a,(size_t)(c-a));p[c-a]=0;*line=(uint32_t)v;return 0;}
int sedit_document_diagnostic(const char*s,char*p,size_t cap,uint32_t*line){
 if(!s||!p||strchr(s,'\n')||strchr(s,'\r'))return-1;while(*s==' '||*s=='\t')s++;
 if(!strncmp(s,"at",2)&&(s[2]==' '||s[2]=='\t')){s+=2;while(*s==' '||*s=='\t')s++;size_t n=strlen(s);while(n&&(s[n-1]==' '||s[n-1]=='\t'))n--;char*b=malloc(n+1);if(!b)return-1;memcpy(b,s,n);b[n]=0;int r=sedit_document_location(b,p,cap,line);free(b);return r;}
 const char*tag=NULL;for(const char*q=s;*q;q++)if(!strncmp(q,": error:",8)||!strncmp(q,": warning:",10)){tag=q;break;}if(!tag)return-1;size_t n=(size_t)(tag-s);char*b=malloc(n+1);if(!b)return-1;memcpy(b,s,n);b[n]=0;
 /* Current cc diagnostics are line-only. A second trailing numeric field is
  * therefore a column-shaped input, not a contract we silently accept. */
 char*last=strrchr(b,':');if(last){char*prev=last;while(prev>b&&prev[-1]!=':')prev--;if(prev>b){int digits=prev<last;for(char*q=prev;q<last;q++)if(*q<'0'||*q>'9')digits=0;if(digits){free(b);return-1;}}}
 int r=sedit_document_location(b,p,cap,line);free(b);return r;
}
int sedit_document_line_offset(const char*t,size_t n,uint32_t line,uint32_t*off,uint32_t*lines){uint32_t l=1,o=0;for(size_t i=0;i<n;i++)if(t[i]=='\n')l++;if(lines)*lines=l;if(line<1||line>l)return-1;if(line==1){*off=0;return 0;}l=1;for(size_t i=0;i<n;i++)if(t[i]=='\n'&&++l==line){o=(uint32_t)i+1;*off=o;return 0;}return-1;}
static int same_opened(SeditDocument*d){struct stat st;if(stat(d->target_path,&st))return 0;if(st.st_dev!=d->opened_stat.st_dev||st.st_ino!=d->opened_stat.st_ino)return 0;char h[65];return sha256_path(d->target_path,h)==0&&!strcmp(h,d->opened_hash);}
enum SeditSaveResult sedit_document_save(SeditDocument*d,const char*path,const char*t,size_t n,int overwrite,int breaklinks){
    char target[1024];struct stat old;int exists=0;if(path&&*path){char parent[1024],*slash;snprintf(parent,sizeof parent,"%s",path);slash=strrchr(parent,'/');if(slash){*slash=0;if(!realpath(*parent?parent:"/",target)){err(d,"realpath",parent);return SEDIT_SAVE_ERROR;}size_t z=strlen(target);snprintf(target+z,sizeof target-z,"/%s",slash+1);}else{if(!getcwd(target,sizeof target)){err(d,"getcwd",path);return SEDIT_SAVE_ERROR;}size_t z=strlen(target);snprintf(target+z,sizeof target-z,"/%s",path);}}else snprintf(target,sizeof target,"%s",d->target_path);
    if(!lstat(target,&old)){exists=1;if(S_ISLNK(old.st_mode)){char r[1024];if(!realpath(target,r)){err(d,"realpath",target);return SEDIT_SAVE_ERROR;}snprintf(target,sizeof target,"%s",r);if(stat(target,&old)){err(d,"stat",target);return SEDIT_SAVE_ERROR;}}}
    if(d->have_snapshot&&!path&&!overwrite&&!same_opened(d))return SEDIT_SAVE_CONFLICT;
    if(exists&&old.st_nlink>1&&!breaklinks)return SEDIT_SAVE_HARDLINK;
    size_t extra=d->bom?3:0;for(size_t i=0;i<n;i++)if(t[i]=='\n')extra+=d->eol==SEDIT_EOL_CRLF?2:1;else extra++;unsigned char*b=malloc(extra?extra:1);if(!b){errno=ENOMEM;err(d,"allocate",target);return SEDIT_SAVE_ERROR;}size_t w=0;if(d->bom){b[w++]=0xef;b[w++]=0xbb;b[w++]=0xbf;}for(size_t i=0;i<n;i++)if(t[i]=='\n'){if(d->eol==SEDIT_EOL_CRLF)b[w++]='\r';b[w++]=d->eol==SEDIT_EOL_CR?'\r':'\n';}else b[w++]=(unsigned char)t[i];
    char tmp[1200];int fd=-1;for(unsigned c=0;c<1000&&fd<0;c++){snprintf(tmp,sizeof tmp,"%s.sedit.%ld.%u.tmp",target,(long)getpid(),c);fd=open(tmp,O_WRONLY|O_CREAT|O_EXCL,exists?(old.st_mode&07777):0666);if(fd<0&&errno!=EEXIST)break;}if(fd<0){err(d,"create temp",target);free(b);return SEDIT_SAVE_ERROR;}if(exists&&fchmod(fd,old.st_mode&07777)){err(d,"chmod temp",tmp);goto fail;}size_t o=0;while(o<w){ssize_t q=write(fd,b+o,w-o);if(q<0&&errno==EINTR)continue;if(q<=0){if(!errno)errno=EIO;err(d,"write temp",tmp);goto fail;}o+=(size_t)q;}if(fsync(fd)){err(d,"fsync temp",tmp);goto fail;}if(close(fd)){fd=-1;err(d,"close temp",tmp);goto fail;}fd=-1;if(rename(tmp,target)){err(d,"rename temp",target);goto fail;}free(b);snprintf(d->user_path,sizeof d->user_path,"%s",path&&*path?path:target);snprintf(d->target_path,sizeof d->target_path,"%s",target);if(stat(target,&d->opened_stat)||sha256_path(target,d->opened_hash)){err(d,"refresh saved file",target);return SEDIT_SAVE_ERROR;}d->have_snapshot=1;d->dirty=0;return SEDIT_SAVE_OK;
fail:{int e=errno;if(fd>=0)close(fd);unlink(tmp);free(b);errno=e;return SEDIT_SAVE_ERROR;}
}
