/* imagetypes.h:
 *
 * supported image types and the imagetypes array declaration.  when you
 * add a new image type, only the makefile and this header need to be
 * changed.
 *
 * jim frost 10.15.89
 */

Image *facesLoad();
Image *pbmLoad();
Image *sunRasterLoad();
Image *gifLoad();
Image *rleLoad();
Image *xwdLoad();
Image *xbitmapLoad();
Image *xpixmapLoad();
Image *g3Load();
Image *fbmLoad();
Image *pcxLoad();
Image *imgLoad();
Image *macLoad();
Image *cmuwmLoad();
Image *mcidasLoad();
Image *jpegLoad();
Image *imLoad();

int facesIdent();
int pbmIdent();
int sunRasterIdent();
int gifIdent();
int rleIdent();
int xwdIdent();
int xbitmapIdent();
int xpixmapIdent();
int g3Ident();
int fbmIdent();
int pcxIdent();
int imgIdent();
int macIdent();
int cmuwmIdent();
int mcidasIdent();
int jpegIdent();
int imIdent();
#ifdef USE_PNG
int pngIdent();
Image *pngLoad();
#endif
