#!/bin/sh
# Runs ONE media process (ffmpeg, ffprobe, MediaMTX) as the media user, uid:gid 1700:1700, with no
# capabilities at all (#553). Usage: media-exec.sh <command> [args...]
#
# Who calls it, and when:
#   - backend/src/lib/childEnv.js, spawnChild(), for EVERY child, but only when the entrypoint exported
#     MEDIA_ISOLATION=on. It resolves this file next to the backend's root (/app/media-exec.sh in the image).
#   - backend/media-probe.sh, from the entrypoint's dry run, before the app is started. The dry run and the
#     app use THIS file, not a copy of its argv, so what the dry run proved is what the app then runs.
#
# Why each part:
#   umask 007     a media file is created group-read/writable (0660, folders 0770) and nothing for "other".
#                 The app has the media group too (the entrypoint's isolated start passes --groups=PGID,1700; the
#                 image itself does not make it a member), so it can still read, move and delete what ffmpeg
#                 writes; a later phase of #553 makes the shared leaf folders sticky so the media user cannot delete
#                 the app's own files. Set here, not inherited: the app's own mask (UMASK, default 077) would
#                 give the media files 0600, which the app, being another uid, could not read.
#   exec          the process keeps the pid Node got back from spawn(). The app signals that pid
#                 (killIfSpawned, the detector watchdog, shutdown): without exec it would signal this shell,
#                 and ffmpeg would be orphaned and keep running.
#   --reuid/--regid/--groups=1700
#                 the media user, its own group, and NO other group: not the app's PGID, so a file the app
#                 made group-readable for its own group is still out of reach. Fixed, container-only ids: the
#                 Dockerfile creates the user (nlmedia) with them, and the entrypoint refuses isolation if
#                 PUID or PGID is 1700.
#   --inh-caps=-all --ambient-caps=-all
#                 the app holds CAP_SETUID, CAP_SETGID and CAP_KILL as AMBIENT capabilities (that is how it can
#                 run this at all); clearing the inheritable and ambient sets here means the exec below starts
#                 the media process with every capability set empty (measured in the #553 spike: CapInh,
#                 CapPrm, CapEff and CapAmb all 0).
#   --no-new-privs
#                 a setuid binary or a file capability can never give the media process more than it has.
#   NO --bounding-set
#                 trimming the bounding set needs CAP_SETPCAP, which the documented six-capability hardening
#                 does not grant, so it FAILS there (#553 spike, run 1). With --no-new-privs and empty
#                 inheritable/ambient sets it adds nothing anyway.
#
# A command that cannot be executed makes setpriv exit 127 (not found) or 126 (found but not executable: EACCES,
# ENOEXEC; util-linux's EX_EXEC_FAILED), and a failed switch to the media user exits 127 too. None of it is an
# 'error' event in Node, because the spawn of this script itself worked. The supervisors back off on either
# (processGuards.js, execFailureBackoff).
# `setpriv` must be util-linux's: BusyBox's applet has no --groups (the Dockerfile installs and checks it).
umask 007
exec setpriv --reuid=1700 --regid=1700 --groups=1700 --inh-caps=-all --ambient-caps=-all --no-new-privs -- "$@"
