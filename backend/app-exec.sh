#!/bin/sh
# Opus plan review of #965: the app holds ambient CAP_SETUID/SETGID/KILL and the media group 1700.
# A plain spawn would hand both to the tunnel daemon. Usage: app-exec.sh <uid> <gid> <command> [args...]
# Refuse root and malformed ids: a broken caller must not turn this into a privileged daemon.
case "$1" in ''|*[!0-9]*|0) exit 2 ;; esac
case "$2" in ''|*[!0-9]*|0) exit 2 ;; esac
case "$1" in *[1-9]*) ;; *) exit 2 ;; esac
case "$2" in *[1-9]*) ;; *) exit 2 ;; esac
uid=$1
gid=$2
shift 2
[ "$#" -ge 1 ] || exit 2
# umask 077 protects state created by the daemon; exec keeps the pid Node signals.
# --reuid/--regid/--groups remove the media group while retaining the app's database access.
# --inh-caps/--ambient-caps empty inherited capabilities (MEASURED #553 spike).
# --no-new-privs stops a later file capability or setuid executable restoring privilege.
umask 077
exec setpriv --reuid="$uid" --regid="$gid" --groups="$gid" --inh-caps=-all --ambient-caps=-all --no-new-privs -- "$@"
