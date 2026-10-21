# Private Tailscale transport build

Pinned dependency: tailscale.com v1.104.1; all transitive modules in go.mod/go.sum.
Build toolchain: official Go 1.27.2 darwin-arm64 archive, SHA-256
76812b213b1b2302c978d28fa52fa92d541704b9e7d9d5db8002c50e4018c4c5.
The toolchain is used for building only and is not installed by the broker.

Build without activating any Tailscale identity:

    go mod verify
    go test ./...
    go build -trimpath -buildvcs=false -o /PATH/muxpad-tsnet .
    /PATH/muxpad-tsnet --version

Tests use private Unix sockets and fake HTTP requests. They do not enroll a node,
open browsers, bind TCP/UDP network listeners, read Slack tokens, or change the
installed system.

Package with official Node v24.22.0 darwin-arm64 (libuv 1.52.1). Its upstream archive SHA-256 is
6a9724d9b50a5f22b4816cded441b5a8d9ddae546191a5e5b7efa5a5e2ee26d5.
Verify the upstream archive checksum before extraction, then package its regular bin/node and LICENSE
files. Homebrew's Node24.13.1 on this machine has libuv1.52, but the OFFICIAL
Node24.13.1 has libuv1.51 and is unsuitable: use24.22.0 instead. Installer and daemon
both fail closed on an unsupported libuv version.

    node broker/prepare-release.mjs --tsnet /PATH/release.tar /PATH/muxpad-tsnet /PATH/node-v24.22.0-darwin-arm64

The release is unsigned/unapproved. Go module checksums and upstream archive hashes
provide integrity evidence, not independent approval of the final privileged
installer. The exact archive, compiled helper, source and runtime require trusted
review before executing a frozen root-owned copy. All privileged invocations must
use the existing documented absolute-path/clean-environment bootstrap procedure.
The new frozen installer takes only CURRENT_MUXPAD_HTTPS_URL and AGENT_OS_USERNAME;
it creates the account, installs its bundled runtime, enrolls its own tsnet node,
prompts for the Slack token without echo, discovers the team ID, generates a pairing
secret and installs the daemon. It does not integrate/restart ordinary muxpad.

References:
https://tailscale.com/docs/reference/tsnet-server-api
https://tailscale.com/docs/features/tsnet
https://nodejs.org/dist/v24.22.0/SHASUMS256.txt
https://go.dev/dl/?mode=json

## Interrupted setup

Enrollment cancellation, a bad Slack token or a temporary network failure can be
resumed by adding `--resume` immediately after the same frozen installer path,
keeping its two original arguments. Use the same trusted administrative invocation:

    /usr/bin/sudo /usr/bin/env -i PATH=/usr/bin:/bin:/usr/sbin:/sbin /bin/bash --noprofile --norc /private/var/root/muxpad-broker-review/broker/install-tsnet.sh --resume https://CURRENT_MUXPAD_HOST/ AGENT_OS_USERNAME

This is for an unfinished setup only. A root-owned pending marker must match the
exact installer checksum; the protected account/state/runtime must still validate.
It preserves the enrolled Tailscale identity and existing state. It refuses a
running daemon or a paired human session. No recursive delete or automatic reset
of existing identity/credentials is performed. Once activation succeeds, the marker
is removed and this recovery path closes. Failures during initial OS account/code
provisioning (before the pending marker exists) require administrator reconciliation;
resume does not claim arbitrary pre-existing accounts/installations.
