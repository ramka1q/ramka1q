export interface Note {
  id: string;
  time: number;
  lane: number;
  hit: boolean;
  missed: boolean;
  cumulativeDistance?: number;
  duration?: number;
  cumulativeDistanceEnd?: number;
}

export interface EnergyData {
  time: number;
  energy: number; // 0.0 to 1.0
  cumulativeDistance: number;
}

export interface GameState {
  score: number;
  combo: number;
  maxCombo: number;
  health: number; // 0 to 100
  hits: number;
  misses: number;
  totalNotes: number;
}
