/* A Bison parser, made by GNU Bison 2.3.  */

/* Skeleton interface for Bison's Yacc-like parsers in C

   Copyright (C) 1984, 1989, 1990, 2000, 2001, 2002, 2003, 2004, 2005, 2006
   Free Software Foundation, Inc.

   This program is free software; you can redistribute it and/or modify
   it under the terms of the GNU General Public License as published by
   the Free Software Foundation; either version 2, or (at your option)
   any later version.

   This program is distributed in the hope that it will be useful,
   but WITHOUT ANY WARRANTY; without even the implied warranty of
   MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
   GNU General Public License for more details.

   You should have received a copy of the GNU General Public License
   along with this program; if not, write to the Free Software
   Foundation, Inc., 51 Franklin Street, Fifth Floor,
   Boston, MA 02110-1301, USA.  */

/* As a special exception, you may create a larger work that contains
   part or all of the Bison parser skeleton and distribute that work
   under terms of your choice, so long as that work isn't itself a
   parser generator using the skeleton or a modified version thereof
   as a parser skeleton.  Alternatively, if you modify or redistribute
   the parser skeleton itself, you may (at your option) remove this
   special exception, which will cause the skeleton and the resulting
   Bison output files to be licensed under the GNU General Public
   License without this special exception.

   This special exception was added by the Free Software Foundation in
   version 2.2 of Bison.  */

/* Tokens.  */
#ifndef YYTOKENTYPE
# define YYTOKENTYPE
   /* Put the tokens into the symbol table, so that GDB and other debuggers
      know about them.  */
   enum yytokentype {
     COMMA = 258,
     NUM = 259,
     DOUBLE = 260,
     ID = 261,
     STR = 262,
     WINSIZ = 263,
     KW_NOOP = 264,
     KW_DEFAULT = 265,
     KW_TAB = 266,
     KW_SIZE = 267,
     KW_FORE = 268,
     KW_BACK = 269,
     KW_LEFT = 270,
     KW_CENTER = 271,
     KW_RIGHT = 272,
     KW_SHRINK = 273,
     KW_LCUTIN = 274,
     KW_RCUTIN = 275,
     KW_CONT = 276,
     KW_NODEF = 277,
     KW_XFONT = 278,
     KW_VFONT = 279,
     KW_IMAGE = 280,
     KW_BIMAGE = 281,
     KW_PAGE = 282,
     KW_HGAP = 283,
     KW_VGAP = 284,
     KW_GAP = 285,
     KW_PAUSE = 286,
     KW_PREFIX = 287,
     KW_AGAIN = 288,
     KW_CCOLOR = 289,
     KW_BAR = 290,
     KW_INCLUDE = 291,
     KW_BGRAD = 292,
     KW_TEXT = 293,
     KW_LINESTART = 294,
     KW_LINEEND = 295,
     KW_MARK = 296,
     KW_SYSTEM = 297,
     KW_FILTER = 298,
     KW_ENDFILTER = 299,
     KW_QUALITY = 300,
     KW_ICON = 301,
     KW_LEFTFILL = 302,
     KW_XSYSTEM = 303,
     KW_VFCAP = 304,
     KW_TFONT = 305,
     KW_TFDIR = 306,
     KW_TSYSTEM = 307,
     KW_DEFFONT = 308,
     KW_FONT = 309,
     KW_TFONT0 = 310,
     KW_EMBED = 311,
     KW_ENDEMBED = 312,
     KW_NEWIMAGE = 313,
     KW_PSFONT = 314,
     KW_CHARSET = 315,
     KW_TMFONT = 316,
     KW_PCACHE = 317,
     KW_TMFONT0 = 318,
     KW_ANIM = 319,
     KW_VALIGN = 320,
     KW_AREA = 321,
     KW_OPAQUE = 322,
     KW_SUP = 323,
     KW_SUB = 324,
     KW_SETSUP = 325,
     KW_M17N = 326
   };
#endif
/* Tokens.  */
#define COMMA 258
#define NUM 259
#define DOUBLE 260
#define ID 261
#define STR 262
#define WINSIZ 263
#define KW_NOOP 264
#define KW_DEFAULT 265
#define KW_TAB 266
#define KW_SIZE 267
#define KW_FORE 268
#define KW_BACK 269
#define KW_LEFT 270
#define KW_CENTER 271
#define KW_RIGHT 272
#define KW_SHRINK 273
#define KW_LCUTIN 274
#define KW_RCUTIN 275
#define KW_CONT 276
#define KW_NODEF 277
#define KW_XFONT 278
#define KW_VFONT 279
#define KW_IMAGE 280
#define KW_BIMAGE 281
#define KW_PAGE 282
#define KW_HGAP 283
#define KW_VGAP 284
#define KW_GAP 285
#define KW_PAUSE 286
#define KW_PREFIX 287
#define KW_AGAIN 288
#define KW_CCOLOR 289
#define KW_BAR 290
#define KW_INCLUDE 291
#define KW_BGRAD 292
#define KW_TEXT 293
#define KW_LINESTART 294
#define KW_LINEEND 295
#define KW_MARK 296
#define KW_SYSTEM 297
#define KW_FILTER 298
#define KW_ENDFILTER 299
#define KW_QUALITY 300
#define KW_ICON 301
#define KW_LEFTFILL 302
#define KW_XSYSTEM 303
#define KW_VFCAP 304
#define KW_TFONT 305
#define KW_TFDIR 306
#define KW_TSYSTEM 307
#define KW_DEFFONT 308
#define KW_FONT 309
#define KW_TFONT0 310
#define KW_EMBED 311
#define KW_ENDEMBED 312
#define KW_NEWIMAGE 313
#define KW_PSFONT 314
#define KW_CHARSET 315
#define KW_TMFONT 316
#define KW_PCACHE 317
#define KW_TMFONT0 318
#define KW_ANIM 319
#define KW_VALIGN 320
#define KW_AREA 321
#define KW_OPAQUE 322
#define KW_SUP 323
#define KW_SUB 324
#define KW_SETSUP 325
#define KW_M17N 326




#if ! defined YYSTYPE && ! defined YYSTYPE_IS_DECLARED
typedef union YYSTYPE

{
	int i;
	double d;
	char *s;
	struct ctrl *ct;
}
/* Line 1529 of yacc.c.  */

	YYSTYPE;
# define yystype YYSTYPE /* obsolescent; will be withdrawn */
# define YYSTYPE_IS_DECLARED 1
# define YYSTYPE_IS_TRIVIAL 1
#endif

extern YYSTYPE yylval;

