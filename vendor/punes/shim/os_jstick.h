/*
 *  c-compiler puNES shim: replaces the platform gui/{linux,bsd,windows}/
 *  os_jstick.h. We have no host joystick backend, but jstick_db.h's controller
 *  database + jstick.c's event mapping (pulled in via qt.h -> jstick.h)
 *  reference the Linux <linux/input-event-codes.h> axis/button codes. We
 *  provide exactly those; the js_os_* backend functions are stubbed in
 *  frontend/pn_stubs.c (no real device is ever opened).
 */
#ifndef OS_JSTICK_H_
#define OS_JSTICK_H_

#define ABS_BRAKE 0xa
#define ABS_DISTANCE 0x19
#define ABS_GAS 0x9
#define ABS_HAT0X 0x10
#define ABS_HAT0Y 0x11
#define ABS_HAT1X 0x12
#define ABS_HAT1Y 0x13
#define ABS_HAT2X 0x14
#define ABS_HAT2Y 0x15
#define ABS_HAT3X 0x16
#define ABS_HAT3Y 0x17
#define ABS_PRESSURE 0x18
#define ABS_RUDDER 0x7
#define ABS_RX 0x3
#define ABS_RY 0x4
#define ABS_RZ 0x5
#define ABS_THROTTLE 0x6
#define ABS_TILT_X 0x1a
#define ABS_TILT_Y 0x1b
#define ABS_TOOL_WIDTH 0x1c
#define ABS_WHEEL 0x8
#define ABS_X 0x0
#define ABS_Y 0x1
#define ABS_Z 0x2
#define BTN_A 0x130
#define BTN_B 0x131
#define BTN_BASE 0x126
#define BTN_BASE2 0x127
#define BTN_BASE3 0x128
#define BTN_BASE4 0x129
#define BTN_BASE5 0x12a
#define BTN_BASE6 0x12b
#define BTN_C 0x132
#define BTN_DEAD 0x12f
#define BTN_DPAD_DOWN 0x221
#define BTN_DPAD_LEFT 0x222
#define BTN_DPAD_RIGHT 0x223
#define BTN_DPAD_UP 0x220
#define BTN_GEAR_DOWN 0x150
#define BTN_GEAR_UP 0x151
#define BTN_MODE 0x13c
#define BTN_PINKIE 0x125
#define BTN_SELECT 0x13a
#define BTN_START 0x13b
#define BTN_THUMB 0x121
#define BTN_THUMB2 0x122
#define BTN_THUMBL 0x13d
#define BTN_THUMBR 0x13e
#define BTN_TL 0x136
#define BTN_TL2 0x138
#define BTN_TOP 0x123
#define BTN_TOP2 0x124
#define BTN_TR 0x137
#define BTN_TR2 0x139
#define BTN_TRIGGER 0x120
#define BTN_TRIGGER_HAPPY 0x2c0
#define BTN_TRIGGER_HAPPY1 0x2c0
#define BTN_TRIGGER_HAPPY10 0x2c9
#define BTN_TRIGGER_HAPPY11 0x2ca
#define BTN_TRIGGER_HAPPY12 0x2cb
#define BTN_TRIGGER_HAPPY13 0x2cc
#define BTN_TRIGGER_HAPPY14 0x2cd
#define BTN_TRIGGER_HAPPY15 0x2ce
#define BTN_TRIGGER_HAPPY16 0x2cf
#define BTN_TRIGGER_HAPPY17 0x2d0
#define BTN_TRIGGER_HAPPY18 0x2d1
#define BTN_TRIGGER_HAPPY19 0x2d2
#define BTN_TRIGGER_HAPPY2 0x2c1
#define BTN_TRIGGER_HAPPY20 0x2d3
#define BTN_TRIGGER_HAPPY21 0x2d4
#define BTN_TRIGGER_HAPPY22 0x2d5
#define BTN_TRIGGER_HAPPY23 0x2d6
#define BTN_TRIGGER_HAPPY24 0x2d7
#define BTN_TRIGGER_HAPPY25 0x2d8
#define BTN_TRIGGER_HAPPY26 0x2d9
#define BTN_TRIGGER_HAPPY27 0x2da
#define BTN_TRIGGER_HAPPY28 0x2db
#define BTN_TRIGGER_HAPPY29 0x2dc
#define BTN_TRIGGER_HAPPY3 0x2c2
#define BTN_TRIGGER_HAPPY30 0x2dd
#define BTN_TRIGGER_HAPPY31 0x2de
#define BTN_TRIGGER_HAPPY32 0x2df
#define BTN_TRIGGER_HAPPY33 0x2e0
#define BTN_TRIGGER_HAPPY34 0x2e1
#define BTN_TRIGGER_HAPPY35 0x2e2
#define BTN_TRIGGER_HAPPY36 0x2e3
#define BTN_TRIGGER_HAPPY37 0x2e4
#define BTN_TRIGGER_HAPPY38 0x2e5
#define BTN_TRIGGER_HAPPY39 0x2e6
#define BTN_TRIGGER_HAPPY4 0x2c3
#define BTN_TRIGGER_HAPPY40 0x2e7
#define BTN_TRIGGER_HAPPY5 0x2c4
#define BTN_TRIGGER_HAPPY6 0x2c5
#define BTN_TRIGGER_HAPPY7 0x2c6
#define BTN_TRIGGER_HAPPY8 0x2c7
#define BTN_TRIGGER_HAPPY9 0x2c8
#define BTN_X 0x133
#define BTN_Y 0x134
#define BTN_Z 0x135

#endif /* OS_JSTICK_H_ */
