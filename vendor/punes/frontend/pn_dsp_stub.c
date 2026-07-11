/*
 *  c-compiler puNES frontend (GPLv3): no-op stubs for the five expansion-audio
 *  DSP "interface" seams whose implementations upstream are C++ (our compiler
 *  builds C only). These back only exotic carts:
 *    - upd7756 / wave_file : ADPCM speech samples (a few mapper-003/072/086 boards)
 *    - hc55516             : CVSD speech
 *    - butterworth         : an anti-alias filter used by the speech chips
 *    - serial_devices      : I2C EEPROM / OneBus GPIO save chips
 *  The referencing C mappers (mapper_003/018/072/086/266, OneBus) still link
 *  and boot; only the extra speech/EEPROM behaviour is inert. Handles are all
 *  `void *` (NULL here), so the callers' null-guards keep them harmless.
 */

#include "common.h"
#include "mappers/upd7756_interface.h"
#include "mappers/hc55516_interface.h"
#include "mappers/butterworth_interface.h"
#include "mappers/serial_devices_interface.h"
#include "mappers/wave_file_interface.h"

/* upd7756 ADPCM */
void upd7756_load_sample_rom(unsigned char *data, size_t size) { (void)data; (void)size; }

/* wave-file speech player */
void wavefiles_clear(void) {}
void wavefiles_restart(int index) { (void)index; }
int wavefiles_get_next_sample(int index) { (void)index; return (0); }
BYTE wavefiles_is_finished(int index) { (void)index; return (TRUE); }

/* hc55516 CVSD */
hc55516 hc55516_create(uint32_t clock) { (void)clock; return (NULL); }
void hc55516_free(hc55516 h) { (void)h; }
void hc55516_reset(hc55516 h) { (void)h; }
void hc55516_start(hc55516 h) { (void)h; }
void hc55516_clock_w(hc55516 h, int state) { (void)h; (void)state; }
void hc55516_digit_w(hc55516 h, int digit) { (void)h; (void)digit; }
void hc55516_sound_stream_update(hc55516 h, int16_t *buffer, int samples) { (void)h; (void)buffer; (void)samples; }

/* butterworth filter */
bfilter butterworth_create(int _n, double s, double f) { (void)_n; (void)s; (void)f; return (NULL); }
void butterworth_free(bfilter b) { (void)b; }
double butterworth_output(bfilter b, double x) { (void)b; return (x); }

/* serial devices: I2C EEPROM + OneBus GPIO */
hserial serial_device_create(void) { return (NULL); }
void serial_device_free(hserial s) { (void)s; }
void serial_device_reset(hserial s) { (void)s; }
BYTE serial_device_get_data(hserial s) { (void)s; return (0); }
void serial_device_set_pins(hserial s, BYTE select, BYTE newClock, BYTE newData) { (void)s; (void)select; (void)newClock; (void)newData; }
BYTE serial_device_save_mapper(hserial s, BYTE mode, BYTE slot, FILE *fp) { (void)s; (void)mode; (void)slot; (void)fp; return (0); }
hgpio_onebus gpio_onebus_create(void) { return (NULL); }
void gpio_onebus_free(hgpio_onebus g) { (void)g; }
void gpio_onebus_reset(hgpio_onebus g) { (void)g; }
void gpio_onebus_attach_serial_device(hgpio_onebus g, hserial s, BYTE select, BYTE clock, BYTE data) { (void)g; (void)s; (void)select; (void)clock; (void)data; }
BYTE gpio_onebus_read(hgpio_onebus g, BYTE address) { (void)g; (void)address; return (0); }
void gpio_onebus_write(hgpio_onebus g, BYTE address, BYTE value) { (void)g; (void)address; (void)value; }
BYTE gpio_onebus_save_mapper(hgpio_onebus g, BYTE mode, BYTE slot, FILE *fp) { (void)g; (void)mode; (void)slot; (void)fp; return (0); }
heeprom_i2c eeprom_24c01_create(BYTE _deviceAddr, BYTE *_rom) { (void)_deviceAddr; (void)_rom; return (NULL); }
heeprom_i2c eeprom_24c02_create(BYTE _deviceAddr, BYTE *_rom) { (void)_deviceAddr; (void)_rom; return (NULL); }
heeprom_i2c eeprom_24c04_create(BYTE _deviceAddr, BYTE *_rom) { (void)_deviceAddr; (void)_rom; return (NULL); }
heeprom_i2c eeprom_24c08_create(BYTE _deviceAddr, BYTE *_rom) { (void)_deviceAddr; (void)_rom; return (NULL); }
heeprom_i2c eeprom_24c16_create(BYTE _deviceAddr, BYTE *_rom) { (void)_deviceAddr; (void)_rom; return (NULL); }
void eeprom_i2c_free(heeprom_i2c e) { (void)e; }
void eeprom_i2c_reset(heeprom_i2c e) { (void)e; }
BYTE eeprom_i2c_get_data(heeprom_i2c e) { (void)e; return (0); }
void eeprom_i2c_set_pins(heeprom_i2c e, BYTE select, BYTE newClock, BYTE newData) { (void)e; (void)select; (void)newClock; (void)newData; }
BYTE eeprom_i2c_save_mapper(heeprom_i2c e, BYTE mode, BYTE slot, FILE *fp) { (void)e; (void)mode; (void)slot; (void)fp; return (0); }
