# Build starters

`build_new {template}` copies one of these folders into the Build project (roadmap P1.6). No network:
the files are here, and the Vite starters install from the npm cache that `cloud-vm/provision.sh`
and `docker/server.Dockerfile` warm at setup. `{{title}}` is replaced with the app's title.

Rules for every starter: it runs in the Device's sandboxed preview frame (no localStorage), Vite
starters set `base: "/preview/"` and listen on 127.0.0.1, and versions are pinned so the warm cache hits.
