// Every fixed string the package puts in front of bytes it signs, hashes, derives or seals.
// Each is ASCII, starts with "clawtrate account ", ends with " v1" and a newline, and none is
// a prefix of another, so no input under one can be read as an input under another.

/** Labels that begin a signed or carried object. The first bytes of its encoding. */
export const LABEL = {
  sessionRequest: "clawtrate account session request v1\n",
  listEntry: "clawtrate account list entry v1\n",
  removalNotice: "clawtrate account removal notice v1\n",
  refusal: "clawtrate account refusal v1\n",
  card: "clawtrate account card v1\n",
  joinTranscript: "clawtrate account join transcript v1\n",
  listSecret: "clawtrate account list secret v1\n",
} as const;

/** Tags in front of hash, derivation and sealing inputs. Never the start of an encoding. */
export const TAG = {
  entryHash: "clawtrate account entry hash v1\n",
  cardHash: "clawtrate account card hash v1\n",
  commitment: "clawtrate account join commitment v1\n",
  transcriptHash: "clawtrate account join transcript hash v1\n",
  words: "clawtrate account join words v1\n",
  decoys: "clawtrate account join decoys v1\n",
  sessionBody: "clawtrate account session body v1\n",
  listSealKey: "clawtrate account list seal key v1\n",
  listSealed: "clawtrate account list sealed v1\n",
  deviceSeal: "clawtrate account device seal v1\n",
} as const;
