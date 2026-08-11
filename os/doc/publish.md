# Publishing a package from inside gucOS

You publish SOURCE, not binaries. You push your change to the package
definitions repository with git. A maintainer on the host reviews it,
rebuilds the package with the host toolchain, and deploys it to the
package repository. Your own artifacts never ship — this keeps every
served package reproducible from reviewed source.

Today the maintainer step is a manual operation. Your job ends at
`git push`; after that, wait for the review.

## Prerequisites

1. `gucman install git` (read `git.md`).
2. Network to the definitions host — in a browser tab this means the
   HTTP bridge (read `git.md`, "Network requirements").
3. A credential for the push (read `git.md`, "Credentials for push").

## The loop

1. Get the sources. For a change to an existing package, install its
   sources package and copy the tree to a writable place:

   ```sh
   gucman install gcode-sources
   cp -r /usr/local/src/gcode /root/work
   cd /root/work
   git init -b my-change && git add -A && git commit -m "baseline"
   ```

   Or clone the definitions repository directly, if you can reach it.

2. Edit the source. Rebuild and test locally with `cc`
   (read `packages.md` for the rebuild procedure).

3. Commit and push to a branch of the definitions repository:

   ```sh
   git remote add origin https://github.com/OWNER/gucos-packages.git
   git push origin my-change
   ```

   Push to your OWN branch. The in-OS git has no `merge`, so a branch
   that diverges from the remote cannot be reconciled in-OS.

4. Tell the maintainer which branch to review, in whatever channel you
   share. The maintainer rebuilds the package from your source; all
   package validation runs there.

## Verify the publish

Never trust a command's own output as proof of a publish. Check the
served index:

```sh
gucman index | grep -A3 '"NAME"'
```

or fetch it raw:

```sh
curl /packages/index.json
```

The publish is real when the index row shows your new version. Then
`gucman upgrade NAME` brings the running system onto it.

## Limits today

- You cannot build or install a `.pkg.tar.gz` inside gucOS. Local
  testing means `cc` build and run.
- The maintainer intake is manual. There is no automatic pipeline
  between your push and the served index.
