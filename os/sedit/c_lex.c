#include "c_lex.h"
#include <ctype.h>
#include <stdlib.h>
#include <string.h>

enum { L_NORMAL, L_BLOCK, L_LINE, L_STRING, L_CHAR, L_PREPROC };

static int grow(void **p, size_t *cap, size_t need, size_t unit) {
    if (*cap >= need) return 1;
    size_t c = *cap ? *cap * 2 : 64;
    while (c < need) c *= 2;
    void *q = realloc(*p, c * unit); if (!q) return 0;
    *p = q; *cap = c; return 1;
}
static int tok(SeditLexer *l, uint32_t a, uint32_t b, int k) {
    if (b <= a) return 1;
    if (!grow((void **)&l->tokens,&l->token_cap,l->token_count+1,sizeof(*l->tokens))) return 0;
    l->tokens[l->token_count++] = (SeditToken){a,b,(uint8_t)k}; return 1;
}
static int pair(SeditLexer *l,uint32_t a,uint32_t b,int unmatched) {
    if (!grow((void **)&l->pairs,&l->pair_cap,l->pair_count+1,sizeof(*l->pairs))) return 0;
    l->pairs[l->pair_count++] = (SeditPair){a,b,(uint8_t)unmatched}; return 1;
}
static int kw(const char *s,size_t n,int *type) {
    static const char *types[]={"auto","bool","char","const","double","enum","extern","float","inline","int","long","register","restrict","short","signed","static","struct","typedef","union","unsigned","void","volatile","_Atomic","_Bool","_Complex","_Imaginary",NULL};
    static const char *words[]={"break","case","continue","default","do","else","for","goto","if","return","sizeof","switch","while","_Alignas","_Alignof","_Generic","_Noreturn","_Static_assert","_Thread_local",NULL};
    for(int i=0;types[i];i++) if(strlen(types[i])==n&&!memcmp(s,types[i],n)){*type=1;return 1;}
    for(int i=0;words[i];i++) if(strlen(words[i])==n&&!memcmp(s,words[i],n)){*type=0;return 1;}
    return 0;
}
static int isident0(unsigned char c){return isalpha(c)||c=='_'||c>=0x80;}
static int isident(unsigned char c){return isalnum(c)||c=='_'||c>=0x80;}
static int match(char a,char b){return (a=='('&&b==')')||(a=='['&&b==']')||(a=='{'&&b=='}');}
static int lex_normal_run(SeditLexer*l,const char*s,size_t n,size_t*i) {
    unsigned char c=(unsigned char)s[*i]; uint32_t at=l->offset+(uint32_t)*i;
    if(c==' '||c=='\t'||c=='\r'){(*i)++;return 1;}
    if(c=='\n'){l->line_start=1;(*i)++;return 1;}
    if(c=='#'&&l->line_start){l->state=L_PREPROC;l->token_start=at;l->escape=0;(*i)++;return 1;}
    l->line_start=0;
    if(c=='/'&&*i+1<n&&s[*i+1]=='*'){l->state=L_BLOCK;l->token_start=at;*i+=2;return 1;}
    if(c=='/'&&*i+1<n&&s[*i+1]=='/'){l->state=L_LINE;l->token_start=at;*i+=2;return 1;}
    if(c=='"'||c=='\''){l->state=c=='"'?L_STRING:L_CHAR;l->token_start=at;l->escape=0;(*i)++;return 1;}
    if(isident0(c)){size_t j=*i+1;while(j<n&&isident((unsigned char)s[j]))j++;int ty=0;if(kw(s+*i,j-*i,&ty)&&!tok(l,at,l->offset+(uint32_t)j,ty?SEDIT_T_TYPE:SEDIT_T_KEYWORD))return 0;*i=j;return 1;}
    if(isdigit(c)||(c=='.'&&*i+1<n&&isdigit((unsigned char)s[*i+1]))){size_t j=*i+1;while(j<n&&(isalnum((unsigned char)s[j])||strchr("._+-",s[j])))j++;if(!tok(l,at,l->offset+(uint32_t)j,SEDIT_T_NUMBER))return 0;*i=j;return 1;}
    if(strchr("()[]{}",c)){
        if(strchr("([{",c)){if(!grow((void**)&l->stack,&l->stack_cap,l->stack_count+1,sizeof(*l->stack)))return 0;l->stack[l->stack_count++]=((uint64_t)at<<8)|c;}
        else if(l->stack_count&&match((char)(l->stack[l->stack_count-1]&255),c)){uint32_t a=(uint32_t)(l->stack[--l->stack_count]>>8);if(!pair(l,a,at,0)||!pair(l,at,a,0))return 0;}
        else if(!pair(l,at,at,1))return 0;
        if(!tok(l,at,at+1,SEDIT_T_PUNCT))return 0;
    }
    (*i)++;return 1;
}
void sedit_lex_init(SeditLexer*l){memset(l,0,sizeof(*l));l->state=L_NORMAL;l->line_start=1;}
int sedit_lex_feed(SeditLexer*l,const char*s,size_t n){
    size_t i=0;if(l->failed)return 0;
    while(i<n){char c=s[i];uint32_t end=l->offset+(uint32_t)i+1;
        if(l->state==L_NORMAL){if(!lex_normal_run(l,s,n,&i))goto oom;continue;}
        if(l->state==L_BLOCK){if(c=='*'&&i+1<n&&s[i+1]=='/'){i+=2;if(!tok(l,l->token_start,l->offset+(uint32_t)i,SEDIT_T_COMMENT))goto oom;l->state=L_NORMAL;}else i++;continue;}
        if(l->state==L_LINE){if(c=='\n'){if(!tok(l,l->token_start,end-1,SEDIT_T_COMMENT))goto oom;l->state=L_NORMAL;l->line_start=1;}i++;continue;}
        if(l->state==L_STRING||l->state==L_CHAR){int k=l->state==L_STRING?SEDIT_T_STRING:SEDIT_T_CHAR;if(l->escape){l->escape=0;i++;continue;}if(c=='\\'){l->escape=1;i++;continue;}if((l->state==L_STRING&&c=='"')||(l->state==L_CHAR&&c=='\'')){i++;if(!tok(l,l->token_start,l->offset+(uint32_t)i,k))goto oom;l->state=L_NORMAL;}else if(c=='\n'){if(!tok(l,l->token_start,end-1,k))goto oom;l->state=L_NORMAL;l->line_start=1;i++;}else i++;continue;}
        if(l->state==L_PREPROC){if(c=='\\'){l->escape=!l->escape;i++;continue;}if(c=='\n'&&!l->escape){if(!tok(l,l->token_start,end-1,SEDIT_T_PREPROCESSOR))goto oom;l->state=L_NORMAL;l->line_start=1;i++;}else{l->escape=0;i++;}continue;}
    }
    l->offset+=(uint32_t)n;return 1;
oom:l->failed=1;return 0;
}
int sedit_lex_finish(SeditLexer*l){if(l->failed)return 0;int k=0;if(l->state==L_BLOCK||l->state==L_LINE)k=SEDIT_T_COMMENT;else if(l->state==L_STRING)k=SEDIT_T_STRING;else if(l->state==L_CHAR)k=SEDIT_T_CHAR;else if(l->state==L_PREPROC)k=SEDIT_T_PREPROCESSOR;if(k&&!tok(l,l->token_start,l->offset,k))return 0;while(l->stack_count){uint32_t a=(uint32_t)(l->stack[--l->stack_count]>>8);if(!pair(l,a,a,1))return 0;}return 1;}
void sedit_lex_free(SeditLexer*l){free(l->tokens);free(l->pairs);free(l->stack);memset(l,0,sizeof(*l));}
int sedit_pair_mate(const SeditLexer*l,uint32_t at,uint32_t*mate,int*unmatched){for(size_t i=0;i<l->pair_count;i++)if(l->pairs[i].at==at){if(mate)*mate=l->pairs[i].mate;if(unmatched)*unmatched=l->pairs[i].unmatched;return 1;}return 0;}
