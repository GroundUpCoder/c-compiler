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

static int io_open_real(const char*p,int f,mode_t m){return open(p,f,m);}
static int io_sha_real(const char*p,char h[65]){return sha256_path(p,h);}
typedef struct {int(*lstat_fn)(const char*,struct stat*);int(*stat_fn)(const char*,struct stat*);char*(*realpath_fn)(const char*,char*);int(*open_fn)(const char*,int,mode_t);ssize_t(*read_fn)(int,void*,size_t);ssize_t(*write_fn)(int,const void*,size_t);int(*close_fn)(int);int(*fchmod_fn)(int,mode_t);int(*fsync_fn)(int);int(*rename_fn)(const char*,const char*);int(*unlink_fn)(const char*);int(*sha256_path_fn)(const char*,char[65]);} DocIO;
static DocIO io={lstat,stat,realpath,io_open_real,read,write,close,fchmod,fsync,rename,unlink,io_sha_real};
#ifdef SEDIT_TEST
static const DocIO real_io={lstat,stat,realpath,io_open_real,read,write,close,fchmod,fsync,rename,unlink,io_sha_real};
void sedit_document_test_io(const SeditIOOps*o){if(!o){io=real_io;return;}io=(DocIO){o->lstat_fn?o->lstat_fn:lstat,o->stat_fn?o->stat_fn:stat,o->realpath_fn?o->realpath_fn:realpath,o->open_fn?o->open_fn:io_open_real,o->read_fn?o->read_fn:read,o->write_fn?o->write_fn:write,o->close_fn?o->close_fn:close,o->fchmod_fn?o->fchmod_fn:fchmod,o->fsync_fn?o->fsync_fn:fsync,o->rename_fn?o->rename_fn:rename,o->unlink_fn?o->unlink_fn:unlink,o->sha256_path_fn?o->sha256_path_fn:io_sha_real};}
#endif

static void err(SeditDocument*d,const char*op,const char*p){snprintf(d->error,sizeof d->error,"%s '%s': %s",op,p?p:"",strerror(errno));}
void sedit_document_init(SeditDocument*d){memset(d,0,sizeof(*d));d->eol=SEDIT_EOL_LF;}
void sedit_document_free(SeditDocument*d){free(d->text);d->text=NULL;d->len=0;}
int sedit_document_new(SeditDocument*d){sedit_document_free(d);memset(d,0,sizeof(*d));d->text=strdup("");d->eol=SEDIT_EOL_LF;return d->text?0:-1;}
static int utf8ok(const unsigned char*s,size_t n){for(size_t i=0;i<n;){unsigned c=s[i],need=0,min=0;if(c<0x80){if(!c)return 0;i++;continue;}if((c&0xe0)==0xc0){need=1;min=0x80;c&=31;}else if((c&0xf0)==0xe0){need=2;min=0x800;c&=15;}else if((c&0xf8)==0xf0){need=3;min=0x10000;c&=7;}else return 0;if(i+need>=n)return 0;for(unsigned k=0;k<need;k++){unsigned q=s[++i];if((q&0xc0)!=0x80)return 0;c=(c<<6)|(q&63);}if(c<min||c>0x10ffff||(c>=0xd800&&c<=0xdfff))return 0;i++;}return 1;}
int sedit_document_load(SeditDocument*d,const char*path){
    struct stat st;if(io.lstat_fn(path,&st)||(!S_ISREG(st.st_mode)&&!S_ISLNK(st.st_mode))){if(!errno)errno=EINVAL;err(d,"open",path);return -1;}
    char real[sizeof d->target_path];if(!io.realpath_fn(path,real)){err(d,"realpath",path);return -1;}if(io.stat_fn(real,&st)||!S_ISREG(st.st_mode)){errno=EINVAL;err(d,"regular file required",real);return -1;}if((uint64_t)st.st_size>SEDIT_MAX_FILE){errno=EFBIG;err(d,"file exceeds 8 MiB",real);return -1;}
    int fd=io.open_fn(real,O_RDONLY,0);if(fd<0){err(d,"open",real);return -1;}size_t n=(size_t)st.st_size;unsigned char*b=malloc(n+1);if(!b){io.close_fn(fd);errno=ENOMEM;err(d,"allocate",real);return -1;}size_t o=0;while(o<n){ssize_t r=io.read_fn(fd,b+o,n-o);if(r<0&&errno==EINTR)continue;if(r<=0){int e=r<0?errno:EIO;free(b);io.close_fn(fd);errno=e;err(d,"read",real);return -1;}o+=(size_t)r;}if(io.close_fn(fd)){int e=errno;free(b);errno=e;err(d,"close",real);return -1;}b[n]=0;
    int bom=n>=3&&!memcmp(b,"\xef\xbb\xbf",3);size_t z=bom?3:0;if(!utf8ok(b+z,n-z)){free(b);errno=EILSEQ;err(d,"valid UTF-8 required",real);return -1;}
    size_t crlf=0,lf=0,cr=0,outn=0;for(size_t i=z;i<n;i++){if(b[i]=='\r'){if(i+1<n&&b[i+1]=='\n'){crlf++;i++;}else cr++;outn++;}else{if(b[i]=='\n')lf++;outn++;}}
    char*out=malloc(outn+1);if(!out){free(b);errno=ENOMEM;err(d,"allocate",real);return -1;}size_t w=0;for(size_t i=z;i<n;i++){if(b[i]=='\r'){if(i+1<n&&b[i+1]=='\n')i++;out[w++]='\n';}else out[w++]=(char)b[i];}out[w]=0;
    enum SeditEol e=SEDIT_EOL_LF;int kinds=(crlf>0)+(lf>0)+(cr>0);if(kinds>1)e=SEDIT_EOL_MIXED;else if(crlf)e=SEDIT_EOL_CRLF;else if(cr)e=SEDIT_EOL_CR;
    sedit_document_free(d);d->text=out;d->len=w;d->eol=e;d->bom=bom;d->dirty=0;snprintf(d->user_path,sizeof d->user_path,"%s",path);snprintf(d->target_path,sizeof d->target_path,"%s",real);d->opened_stat=st;sha256_of(b,n,d->opened_hash);d->have_snapshot=1;d->identity_invalid=0;d->error[0]=0;free(b);return 0;
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
int sedit_navigation_apply(const char*t,size_t n,uint32_t line,uint32_t*selection,uint32_t*navigation,uint32_t*lines){uint32_t off=0,seen=0;int r=sedit_document_line_offset(t,n,line,&off,&seen);if(lines)*lines=seen;if(r)return-1;*selection=off;*navigation=line;return 0;}
static int same_opened(SeditDocument*d){struct stat st;char real[sizeof d->target_path];
 if(!d->user_path[0]||!io.realpath_fn(d->user_path,real)||strcmp(real,d->target_path))return 0;
 if(io.stat_fn(real,&st))return 0;if(st.st_dev!=d->opened_stat.st_dev||st.st_ino!=d->opened_stat.st_ino)return 0;char h[65];if(io.sha256_path_fn(real,h)){err(d,"hash current file",real);return-1;}return!strcmp(h,d->opened_hash);}
enum SeditSaveResult sedit_document_save(SeditDocument*d,const char*path,const char*t,size_t n,int overwrite,int breaklinks){
    char target[1024];struct stat old;int exists=0;if(path&&*path){char parent[1024],*slash;snprintf(parent,sizeof parent,"%s",path);slash=strrchr(parent,'/');if(slash){*slash=0;if(!io.realpath_fn(*parent?parent:"/",target)){err(d,"realpath",parent);return SEDIT_SAVE_ERROR;}size_t z=strlen(target);snprintf(target+z,sizeof target-z,"/%s",slash+1);}else{if(!getcwd(target,sizeof target)){err(d,"getcwd",path);return SEDIT_SAVE_ERROR;}size_t z=strlen(target);snprintf(target+z,sizeof target-z,"/%s",path);}}else if(overwrite){if(!d->user_path[0]||!io.realpath_fn(d->user_path,target)){err(d,"realpath current target",d->user_path);return SEDIT_SAVE_ERROR;}}else snprintf(target,sizeof target,"%s",d->target_path);
    if(d->identity_invalid&&!path&&!overwrite)return SEDIT_SAVE_CONFLICT;
    if(!io.lstat_fn(target,&old)){exists=1;if(S_ISLNK(old.st_mode)){char r[1024];if(!io.realpath_fn(target,r)){err(d,"realpath",target);return SEDIT_SAVE_ERROR;}snprintf(target,sizeof target,"%s",r);if(io.stat_fn(target,&old)){err(d,"stat",target);return SEDIT_SAVE_ERROR;}}}
    if(d->have_snapshot&&!path&&!overwrite){int same=same_opened(d);if(same<0)return SEDIT_SAVE_ERROR;if(!same)return SEDIT_SAVE_CONFLICT;}
    if(exists&&old.st_nlink>1&&!breaklinks)return SEDIT_SAVE_HARDLINK;
    size_t extra=d->bom?3:0;for(size_t i=0;i<n;i++)if(t[i]=='\n')extra+=d->eol==SEDIT_EOL_CRLF?2:1;else extra++;unsigned char*b=malloc(extra?extra:1);if(!b){errno=ENOMEM;err(d,"allocate",target);return SEDIT_SAVE_ERROR;}size_t w=0;if(d->bom){b[w++]=0xef;b[w++]=0xbb;b[w++]=0xbf;}for(size_t i=0;i<n;i++)if(t[i]=='\n'){if(d->eol==SEDIT_EOL_CRLF)b[w++]='\r';b[w++]=d->eol==SEDIT_EOL_CR?'\r':'\n';}else b[w++]=(unsigned char)t[i];
    char tmp[1200];int fd=-1;for(unsigned c=0;c<1000&&fd<0;c++){snprintf(tmp,sizeof tmp,"%s.sedit.%ld.%u.tmp",target,(long)getpid(),c);fd=io.open_fn(tmp,O_WRONLY|O_CREAT|O_EXCL,exists?(old.st_mode&07777):0666);if(fd<0&&errno!=EEXIST)break;}if(fd<0){err(d,"create temp",target);free(b);return SEDIT_SAVE_ERROR;}if(exists&&io.fchmod_fn(fd,old.st_mode&07777)){err(d,"chmod temp",tmp);goto fail;}size_t o=0;while(o<w){ssize_t q=io.write_fn(fd,b+o,w-o);if(q<0&&errno==EINTR)continue;if(q<=0){if(!errno)errno=EIO;err(d,"write temp",tmp);goto fail;}o+=(size_t)q;}if(io.fsync_fn(fd)){err(d,"fsync temp",tmp);goto fail;}if(io.close_fn(fd)){fd=-1;err(d,"close temp",tmp);goto fail;}fd=-1;if(io.rename_fn(tmp,target)){err(d,"rename temp",target);goto fail;}free(b);if(path&&*path)snprintf(d->user_path,sizeof d->user_path,"%s",path);snprintf(d->target_path,sizeof d->target_path,"%s",target);d->have_snapshot=0;d->identity_invalid=1;if(io.stat_fn(target,&d->opened_stat)){err(d,"refresh stat after publication",target);return SEDIT_SAVE_PUBLISHED_REFRESH_FAILED;}if(io.sha256_path_fn(target,d->opened_hash)){err(d,"refresh hash after publication",target);return SEDIT_SAVE_PUBLISHED_REFRESH_FAILED;}d->have_snapshot=1;d->identity_invalid=0;d->dirty=0;return SEDIT_SAVE_OK;
fail:{int e=errno;if(fd>=0)io.close_fn(fd);if(io.unlink_fn(tmp)){int ue=errno;size_t z=strlen(d->error);snprintf(d->error+z,sizeof d->error-z,"; cleanup unlink '%s': %s",tmp,strerror(ue));}free(b);errno=e;return SEDIT_SAVE_ERROR;}
}
