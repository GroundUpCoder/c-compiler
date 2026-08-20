#include "styles.h"
#include <stdlib.h>
#include <string.h>

#define SEDIT_RGB(r,g,b) ((uint32_t)(r)|((uint32_t)(g)<<8)|((uint32_t)(b)<<16))

static uint32_t color_for(int k){switch(k){case SEDIT_T_KEYWORD:return SEDIT_RGB(0,0,170);case SEDIT_T_TYPE:return SEDIT_RGB(95,0,111);case SEDIT_T_NUMBER:return SEDIT_RGB(122,31,93);case SEDIT_T_STRING:case SEDIT_T_CHAR:return SEDIT_RGB(139,0,0);case SEDIT_T_COMMENT:return SEDIT_RGB(0,100,0);case SEDIT_T_PREPROCESSOR:return SEDIT_RGB(107,62,0);case SEDIT_T_ERROR:return SEDIT_RGB(170,0,0);default:return SEDIT_RGB(35,35,35);}}
static int append_style(GUCEDIT_BATCH_V1*b,uint32_t*count,const char*text,uint32_t a,uint32_t e,uint32_t col,uint32_t flags){while(a<e){uint32_t q=a;while(q<e&&text[q]!='\n')q++;if(q>a){GUCEDIT_STYLE_V1*s=&b->styles[(*count)++];*s=(GUCEDIT_STYLE_V1){a,q,col,0,flags};}a=q<e?q+1:q;}return 1;}
GUCEDIT_BATCH_V1 *sedit_styles_build(const SeditLexer*lex,const char*text,size_t len,uint32_t caret,uint32_t generation,int*truncated){
 *truncated=0;
 size_t cap=lex->token_count+lex->pair_count+16;GUCEDIT_BATCH_V1*b=malloc(sizeof(*b)+cap*sizeof(GUCEDIT_STYLE_V1));if(!b)return NULL;uint32_t c=0;
 for(size_t i=0;i<lex->token_count;i++)append_style(b,&c,text,lex->tokens[i].start,lex->tokens[i].end,color_for(lex->tokens[i].kind),0);
 uint32_t at=UINT32_MAX,mate=0;int unmatched=0;if(caret<len&&strchr("()[]{}",text[caret]))at=caret;else if(caret&&strchr("()[]{}",text[caret-1]))at=caret-1;
 if(at!=UINT32_MAX&&sedit_pair_mate(lex,at,&mate,&unmatched)){append_style(b,&c,text,at,at+1,unmatched?SEDIT_RGB(180,0,0):SEDIT_RGB(0,70,160),GUES_BOX);if(!unmatched&&mate!=at)append_style(b,&c,text,mate,mate+1,SEDIT_RGB(0,70,160),GUES_BOX);}
 /* token order is lexical; caret boxes can be out of order. Sort and drop
  * token overlap at boxed delimiters (punctuation has no semantic color). */
 for(uint32_t i=1;i<c;i++){GUCEDIT_STYLE_V1 v=b->styles[i];uint32_t j=i;while(j&&b->styles[j-1].start>v.start){b->styles[j]=b->styles[j-1];j--;}b->styles[j]=v;}
 uint32_t w=0;for(uint32_t i=0;i<c;i++){if(w&&b->styles[i].start<b->styles[w-1].end){if(b->styles[i].flags&GUES_BOX)b->styles[w-1]=b->styles[i];continue;}b->styles[w++]=b->styles[i];}c=w;
 b->size=(uint32_t)(sizeof(*b)+c*sizeof(GUCEDIT_STYLE_V1));b->version=1;b->text_generation=generation;b->count=c;
 return b;
}
