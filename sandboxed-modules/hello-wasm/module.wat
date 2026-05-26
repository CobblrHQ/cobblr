;; Marketplace v0.3 sample sandboxed module — "hello-wasm".
;;
;; Exercises the four shipped op codes + the deadline-termination
;; safety mechanism. Hand-rolled WAT for now — a proper SDK in
;; AssemblyScript / Rust will eventually generate something like
;; this from a higher-level source. See
;; docs/design-decisions/module-isolation.md.
;;
;; Compile with:
;;   npx -p wabt wat2wasm \
;;     sandboxed-modules/hello-wasm/module.wat \
;;     -o   sandboxed-modules/hello-wasm/module.wasm
;;
;; Exports:
;;   handle       — ACTIVITY_LOG (the smoke test)
;;   emit         — EVENT_EMIT  (broadcasts "hello-wasm.greeted")
;;   notify_self  — NOTIFICATION_SEND  to the invoking user
;;   spin         — infinite loop; the host's deadline terminator
;;                  should kill the worker + return 504

(module
  (import "host" "host_log"
    (func $host_log (param i32 i32 i32)))
  (import "host" "host_platform_call"
    (func $host_platform_call (param i32 i32 i32) (result i32)))

  (memory (export "memory") 1)

  ;; ─── Static string + JSON payloads ──────────────────────────
  ;;
  ;; Layout chosen so each block has plenty of headroom. Offsets are
  ;; arbitrary but stable; ints below reference them by global.
  ;;
  ;; 0x000  "hello-wasm invoked"                            (18 bytes)
  ;; 0x100  ACTIVITY_LOG JSON                               (46 bytes)
  ;; 0x200  EVENT_EMIT   JSON                               (varies)
  ;; 0x300  NOTIFICATION_SEND JSON                          (varies)
  ;; 0x400  "hello-wasm emit"                               (15 bytes)
  ;; 0x500  "hello-wasm notify_self"                        (22 bytes)
  (data (i32.const 0x000) "hello-wasm invoked")
  (data (i32.const 0x100) "{\"action\":\"greet\",\"message\":\"hello from wasm\"}")
  (data (i32.const 0x200) "{\"event\":\"greeted\",\"payload\":{\"who\":\"world\"}}")
  (data (i32.const 0x300) "{\"user_id\":\"self\",\"message\":\"hi from your sandboxed module\"}")
  (data (i32.const 0x400) "hello-wasm emit")
  (data (i32.const 0x500) "hello-wasm notify_self")

  (global $LOG_INFO   i32 (i32.const 1))

  ;; OP_* mirror api/src/sandbox/abi.ts. Update both if abi.ts changes.
  (global $OP_ACTIVITY_LOG       i32 (i32.const 1))
  (global $OP_EVENT_EMIT         i32 (i32.const 2))
  (global $OP_NOTIFICATION_SEND  i32 (i32.const 3))

  ;; ─── handle: ACTIVITY_LOG ────────────────────────────────────
  (func (export "handle")
    global.get $LOG_INFO
    i32.const 0x000   ;; "hello-wasm invoked"
    i32.const 18
    call $host_log

    global.get $OP_ACTIVITY_LOG
    i32.const 0x100
    i32.const 46
    call $host_platform_call
    drop
  )

  ;; ─── emit: EVENT_EMIT ────────────────────────────────────────
  (func (export "emit")
    global.get $LOG_INFO
    i32.const 0x400   ;; "hello-wasm emit"
    i32.const 15
    call $host_log

    global.get $OP_EVENT_EMIT
    i32.const 0x200
    i32.const 45
    call $host_platform_call
    drop
  )

  ;; ─── notify_self: NOTIFICATION_SEND ─────────────────────────
  ;; Uses the "user_id": "self" sentinel so the host translates
  ;; that into the invoking user's actual id — the wasm doesn't
  ;; need to know who called it.
  (func (export "notify_self")
    global.get $LOG_INFO
    i32.const 0x500   ;; "hello-wasm notify_self"
    i32.const 22
    call $host_log

    global.get $OP_NOTIFICATION_SEND
    i32.const 0x300
    i32.const 60
    call $host_platform_call
    drop
  )

  ;; ─── spin: deadline-test ────────────────────────────────────
  ;; Infinite loop. The host's per-invocation timer (default 1000ms)
  ;; should fire worker.terminate() and the route should return 504.
  (func (export "spin")
    (block (loop
      br 0
    ))
  )
)
