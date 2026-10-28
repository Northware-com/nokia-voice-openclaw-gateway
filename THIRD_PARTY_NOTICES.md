# Third-party notices

Original project code is licensed under [MIT](LICENSE). Dependencies retain their own licenses; the installed package license files remain authoritative.

| Package | Version | License | Usage / upstream |
|---|---|---|---|
| ws | 8.21.3 | MIT | Runtime WebSocket client; [websockets/ws](https://github.com/websockets/ws) |
| TypeScript | 6.0.3 | Apache-2.0 | Development compiler; [microsoft/TypeScript](https://github.com/microsoft/TypeScript) |
| @types/node | 22.19.19 | MIT | Development type declarations; [DefinitelyTyped](https://github.com/DefinitelyTyped/DefinitelyTyped) |
| undici-types | 6.21.0 | MIT | Transitive Node type dependency; [nodejs/undici](https://github.com/nodejs/undici) |

Node.js itself is an external runtime with MIT and bundled third-party license notices; see [Node.js](https://nodejs.org).

## Protocol implementation

The bridge targets an observed OpenClaw WebSocket contract. Its implementation was developed using source-level inspection of the serving gateway's reference behavior, including V3 signed device authentication. This repository does not bundle the OpenClaw gateway or its source snapshot. It does not claim an upstream compatibility endorsement or clean-room provenance.

KaiOS/Nokia firmware, stock application archives, SDK components, recovery images and calibration data are not included. The project communicates with existing system interfaces and retains stock calling/audio dependencies; it does not redistribute them.
