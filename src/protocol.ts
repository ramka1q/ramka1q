export type Lane = 0 | 1 | 2 | 3;

export interface StartGamePayload {
  roomId: string;
  startTime: number;
}

export interface ScoreSnapshot {
  score: number;
  combo: number;
  misses: number;
}

export interface ScoreUpdatePayload extends ScoreSnapshot {
  roomId: string;
  sequence: number;
}

export interface OpponentHitPayload {
  lane: Lane;
}

export interface HitReport {
  noteId: string;
  hitTime: number;
}
