// The controller's one slot: what the call controller is busy with right now.
//   idle    nothing runs
//   doctor  the readiness check runs ({ proc, promise })
//   call    a call child runs ({ child, stopSentAt })
// Allowed edges: idle -> doctor | call, doctor -> idle, call -> idle. A check and a call never run together (they share the mic).
// A finished call whose process is only keeping the answer window up is `lingering` (a child, not a slot kind): it is not busy and a new call replaces it.
// An edge that is not allowed is ignored and logged; the caller gets false. No electron import: unit-tested.

const EDGES = Object.freeze({ idle: ["doctor", "call"], doctor: ["idle"], call: ["idle"] });

/**
 * @param {(msg: string) => void} [log] Called for an ignored edge.
 * @returns {any} { value, kind, child, doctor, lingering, to(kind, data) }
 */
function createSlot(log) {
  let value = { kind: "idle" };
  let lingering;
  return {
    get value() {
      return value;
    },
    get kind() {
      return value.kind;
    },
    /** The running call's child process, or undefined when no call runs. */
    get child() {
      return value.kind === "call" ? value.child : undefined;
    },
    /** The running check ({ proc, promise }), or undefined. */
    get doctor() {
      return value.kind === "doctor" ? value : undefined;
    },
    get lingering() {
      return lingering;
    },
    set lingering(c) {
      lingering = c;
    },
    /** Moves to `kind` (with its data). Returns false, and logs, when the edge is not allowed. */
    to(kind, data = {}) {
      if (!EDGES[value.kind] || !EDGES[value.kind].includes(kind)) {
        if (log) log(`slot: ignored ${value.kind} -> ${kind}`);
        return false;
      }
      value = { ...data, kind };
      return true;
    },
  };
}

module.exports = { createSlot, EDGES };
