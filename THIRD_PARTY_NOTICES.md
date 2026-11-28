# Third-party notices

Code ported into this repository from other projects, and the notices their licences require. Dependencies installed from npm carry their own licences and are not listed here.

## T3 Code

Source: https://github.com/pingdotgg/t3code, commit `18d1c4db`. Licence: MIT.

| File in this repository                               | Ported from                                                                                    |
| ----------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `packages/relay-protocol/src/register-proof.ts`       | `packages/shared/src/dpop.ts`, `infra/relay/src/auth/DpopProofs.ts`                            |
| `packages/relay-protocol/test/register-proof.test.ts` | `packages/shared/src/dpop.test.ts`, `infra/relay/src/auth/DpopProofs.verifyAndConsume.test.ts` |

```
MIT License

Copyright (c) 2026 T3 Tools Inc.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Cacophony test vectors

`packages/relay-protocol/test/vectors/cacophony-ik.json` holds the `Noise_IK_25519_ChaChaPoly_SHA256` vectors from https://github.com/haskell-cryptography/cacophony, commit `8ee9d41e`, `vectors/cacophony.txt`. Cacophony is released into the public domain under the Unlicense; no notice is required, and the source is named as a courtesy.

## BIP-39 English word list

`packages/account-protocol/src/wordlist.ts` holds the BIP-39 English word list, 2,048 words, from https://github.com/trezor/python-mnemonic, commit `b57a5ad7`, `src/mnemonic/wordlist/english.txt` (identical to `bip-0039/english.txt` in https://github.com/bitcoin/bips; SHA-256 `2f5eed53a4727b4bf8880d8f3f199efc90e58503646d9ff8eff3a2ed3b24dbda`). Licence: MIT.

```
The MIT License (MIT)

Copyright (c) 2013-2016 Pavol Rusnak

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
