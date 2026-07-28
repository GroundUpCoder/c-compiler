// todos/0325 Group A — fma(). BEHAVIOUR, not linkage.
//
// fma's whole contract is that x*y+z rounds ONCE. WebAssembly has no fused
// multiply-add, so ours is emulated (compiler.js __math.c) — which makes a
// differential test against a real hardware fma the only meaningful check.
// Every expected value below was produced by clang using the hardware fma;
// the inputs are the adversarial cases plus samples from the near-1.0
// double-rounding regime and the subnormal-result regime, which is where a
// naive `x*y + z` and a careless emulation respectively go wrong.
//
// Compared as raw BITS, not %a: C99 leaves the leading hex digit of a
// subnormal unspecified, so the two printf implementations legitimately
// disagree on formatting, and comparing formatted text would report a
// difference that is not there (and could equally hide a 1-ulp one that is).
#include <stdio.h>
#include <math.h>
#include <string.h>

static void show(const char *tag, double d) {
  unsigned long long u;
  memcpy(&u, &d, sizeof u);
  printf("%s %016llx\n", tag, u);
}

int main(void) {
  static const double CASES[][3] = {
    {0x1p+0, 0x1p+0, 0x1p+0},
    {0x1.fffffffffffffp+0, 0x1.fffffffffffffp+0, -0x1.fffffffffffffp+1},
    {0x1.0000000000001p+0, 0x1.0000000000001p+0, -0x1p+0},
    {0x1p-1074, 0x1p-1074, 0x1p+0},
    {0x1.0000000000001p+0, 0x1.0000000000001p+0, -0x1p+0},
    {0x1.7e43c8800759cp+996, 0x1.56e1fc2f8f359p-997, 0x1p+0},
    {0x1.8p+1, 0x1.cp+2, 0x1.6p+3},
    {0x1.999999999999ap-4, 0x1.999999999999ap-4, 0x1.999999999999ap-4},
    {-0x1p+0, 0x1p+0, 0x1p+0},
    {0x1.fffffffffffffp+1023, 0x1p-1, -0x1.fffffffffffffp+1022},
    {0x1.7c8f8d00cbf66p-403, 0x1.e0983ca5fbf98p-626, -0x1.def0cc033cdcep-1023},
    {-0x1.10fd5b0fd7c6fp-303, 0x1.1582571e07d57p-758, -0x1.08932b8d810dap-1023},
    {-0x1.d9c28a9741a02p-6, -0x1.d14d4430c32b6p+14, -0x1.6ae2c20764753p-14},
    {-0x1.336ec93771f1dp+2, 0x1.9312058b39663p+3, 0x1.10c145535098fp-10},
    {-0x1.6e2665154e05cp-6, -0x1.6d597e9fdde9cp+5, -0x1.665ed06c80221p-3},
    {0x1.c4fbc1a4b3a65p+12, -0x1.11497bd5f9551p-18, -0x1.fea2e8b1c5e3bp+10},
    {-0x1.e5a8e8a548847p-3, 0x1.032063244d097p-12, -0x1.a1fab0cea9cf6p+7},
    {0x1.d875f5b54b44fp-1, 0x1.a8c607b88eee7p-12, 0x1.d0726096ca6fap-12},
    {-0x1.b009688e68137p-1, -0x1.31aca8f9be1f5p-1, -0x1.19f2b96ae0b76p-17},
    {0x1.112fb3eaf4aep-12, -0x1.edd7dd2b6ac75p-19, 0x1.3a789a9ec7c6dp+14},
    {0x1.6abcb71871fd5p-7, -0x1.c50c2ec0d44aap-11, 0x1.a817bab5734a3p-19},
    {0x1.e4148cb4cd20ap+1, -0x1.391ce01f3892ep+6, 0x1.6453c5b4fe5bcp+11},
    {0x1.f74a626599577p-20, -0x1.51ab0f9e49b9dp-2, -0x1.10703599615eap-12},
    {-0x1.05ed3fe9f0341p-20, -0x1.2a8d784c4cd07p+8, 0x1.7ee4249e4e55dp+8},
    {-0x1.5e9fb9f4bdbd7p+1, -0x1.5ccd472b959ap-20, -0x1.fc27ad9184313p-13},
    {-0x1.b3ddacc72d755p+12, -0x1.a7bf6b0c347bbp+0, 0x1.3cfbd9a6c4ff4p+5},
    {0x1.953622763ea6bp+1, -0x1.cf094e864d77fp+1, -0x1.9759f004c2111p+6},
    {-0x1.9f2701340dd13p+13, 0x1.32e1ec8217869p+6, 0x1.a9330d35000d9p-1},
    {0x1.0fd930bddb698p-12, -0x1.221383b9eabf5p-18, -0x1.7de7ceef9cbe2p+1},
    {-0x1.9537191c080f5p-8, -0x1.00a302bb59cb4p-17, 0x1.9c97ea0095a8dp+19},
    {0x1.f59d9e2be4b78p+13, -0x1.e4248e45ae9eep+3, 0x1.c4c55f16fe7bdp-1},
    {-0x1.a649a13e77732p-2, 0x1.e355d5a43355cp-2, -0x1.bb80bdefd6436p+16},
    {0x1.8e36d7c63537ep-8, 0x1.2ae39c0908a58p-19, 0x1.e31f7fce03d4cp-10},
    {0x1.3b68970d32e36p+19, -0x1.abbddb8ebc5eap-1, -0x1.60d75101428e1p-5},
    {0x1.5ea6d4bc218fp+7, -0x1.2f608634fa0c1p+18, -0x1.515670bf92fcp+8},
    {0x1.51b4a45632d9fp+3, 0x1.ab26334996c04p-9, 0x1.2cb0e4693dfdcp+2},
    {0x1.50ffe9bd48f63p-8, -0x1.4ad643f569ebdp+18, 0x1.7586b88d83ccp-15},
    {-0x1.b419f172cbcb9p-20, 0x1.33949a2baeb8p+11, 0x1.53d6e3e9b7e57p-14},
    {0x1.53cae51253d6bp-8, 0x1.391ad78c74dd1p-14, 0x1.06677d44b970ap-12},
    {0x1.4b6085eaf82a4p-7, -0x1.6bdebfce4f4a1p-6, -0x1.56c9be6a43508p+19},
    {-0x1.c21e580013f62p+3, 0x1.1c983279aa59cp-13, 0x1.909b47c6177d7p-3},
    {-0x1.19d4963cea0f8p+15, -0x1.82d2ed1cc03b9p+16, -0x1.2d2c9d4e455fep-14},
    {-0x1.8764bb14d22d5p-16, -0x1.da0198a9daddp+17, 0x1.57adb6e4fe28bp+11},
    {0x1.22549c826bf8ep-8, -0x1.3c1a4270ad171p-1, 0x1.2a47286f8b893p+11},
    {0x1.a98d6d08d0d22p-19, -0x1.9bdd4c0bb1fb8p-13, -0x1.8eb9d2b048787p+8},
    {-0x1.7b9675e138f48p+9, 0x1.a6f4a91097a56p+1, -0x1.b896f137b3d22p-9},
    {0x1.eafbbf386c3d8p+13, -0x1.b793ccd14385fp-18, 0x1.41448b955e7efp+3},
    {0x1.17a226e6357ep+13, 0x1.a2cad0a08694fp-16, 0x1.08ca84b95ca5dp-7},
    {0x1.f80a6ea29d689p+10, -0x1.985ea19910764p+13, -0x1.39d4b71db7c6ap+5},
    {-0x1.27a43de4e9012p+17, -0x1.b05218b3049b2p+8, 0x1.6f02b064005a1p+18},
    {0x1.6d6315b2dcdeap-10, -0x1.5aa0512b7acf1p+5, 0x1.0238cff37dfe8p+18},
    {0x1.73e94446d4a57p+12, -0x1.ea08e14fbe503p-1, 0x1.ba9c32e993209p+9},
    {0x1.4cc2956b5ae29p-529, 0x1.c5c5ec2dc6f35p-538, -0x1.500443p-1048},
    {-0x1.a89a54648bbb4p-518, 0x1.a4e16061a47c3p-517, 0x1.4d7372367e38cp-1015},
    {-0x1.c6b8a69828115p-523, -0x1.147518f7d6157p-511, -0x1.d1e71p-1049},
    {-0x1.21249d49b41d3p-497, -0x1.cad3bcef8639p-536, 0x1.33553e5a17757p-1022},
    {0x1.622ffb39a6039p-497, 0x1.eabe113107ab9p-514, -0x1.a986fb267d40cp-1024},
    {0x1.d77a6be994e95p-502, -0x1.46bff8ef57948p-507, -0x1.20a2ae0ebc2p-1030},
    {0x1.636cb545b0888p-525, 0x1.308b98c129c99p-508, 0x1.1c1p-1061},
    {-0x1.2d09b40d3842ap-528, 0x1.b1f9ce17269a2p-532, 0x1.2208882fc8p-1037},
    {-0x1.fc717de804a7bp-488, 0x1.7167f303eb42fp-547, 0x1.0ef7452782287p-1009},
    {-0x1.35a0a618112a4p-524, 0x1.03cb244503981p-495, -0x1.cbf1d8082d9bp-1025},
    {-0x1.f6101916ff32p-521, 0x1.36221fe59e4c6p-525, 0x1.39dd86p-1050},
    {-0x1.3d6a1ab533422p-509, 0x1.e5895efd8dacap-520, 0x1.18e751a969ap-1026},
    {0x1.87f55d6dd2c5ap-510, -0x1.f1f64eeb4c082p-509, 0x1.ca12481p-1046},
    {-0x1.848d27544bc7dp-510, 0x1.24c6b03848a45p-513, 0x1.dd991p-1053},
    {0x1.0c5aef0a97577p-548, -0x1.602fb9d019a5dp-491, 0x1.631944544ae29p-1015},
    {-0x1.ec59dc5f7f56fp-543, -0x1.73d803fa6a145p-511, 0x1.f90b238d71cp-1032},
    {-0x1.c8295ffcb6bf8p-517, 0x1.a16344dcf032fp-497, 0x1.04b51db23b7p-1028},
    {-0x1.87d37490b4013p-500, 0x1.1d3a869ed3253p-493, -0x1.53f58ddd62p-1033},
    {0x1.d8932ed7a3e54p-517, -0x1.980ff2fb5df28p-529, 0x1.5c7337a548p-1032},
    {0x1.ccac821715e4cp-513, -0x1.1a820994daffp-521, 0x1.58daaafb4c8bp-1023},
  };
  int n = (int)(sizeof(CASES) / sizeof(CASES[0]));
  for (int i = 0; i < n; i++) show("fma", fma(CASES[i][0], CASES[i][1], CASES[i][2]));

  // A case where the naive x*y+z demonstrably differs (found by search
  // against hardware fma), so this test FAILS against a stub that just
  // computes x*y+z rather than passing vacuously.
  double x = -0x1.2e144d6e8f2cfp+1, y = -0x1.a792e1af470eap-2, z = -0x1.a4e85b0d6e28bp-2;
  show("exact", fma(x, y, z));
  show("naive", x * y + z);
  printf("naive_differs=%d\n", fma(x, y, z) != (x * y + z));

  // float fma is exact via double, so it must agree with the double form.
  show("fmaf", (double)fmaf(3.0f, 7.0f, 11.0f));
  return 0;
}
