WT=$HOME/Developer/worktrees/muxpad/readme-reshoot
MXENV=(env -i HOME=/private/tmp/mxd/home USER=$USER LOGNAME=$USER SHELL=/bin/zsh TERM=xterm-256color LANG=en_US.UTF-8
  PATH=$WT/scripts:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin
  MUXPAD_HOST=127.0.0.1 MUXPAD_PORT=17877 MUXPAD_DATA_DIR=/private/tmp/mxd/data
  MUXPAD_PTYD_SOCKET=/private/tmp/mxd/data/ptyd.sock MUXPAD_PUBLIC_PORT=17878 MUXPAD_PUBLIC_HOST=127.0.0.1
  MUXPAD_NO_FUNNEL=1 MUXPAD_PUBLIC_BASE_URL=https://share.example.net TZ=America/Los_Angeles NODE_TLS_REJECT_UNAUTHORIZED=0)
