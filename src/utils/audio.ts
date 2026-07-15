import { Note, EnergyData } from '../types';

export const analyzeAudio = async (file: File, sensitivity: number): Promise<{ buffer: AudioBuffer; beatmap: Note[]; energyData: EnergyData[] }> => {
  const audioContext = new (window.AudioContext || (window as any).webkitAudioContext)();
  const arrayBuffer = await file.arrayBuffer();
  const audioBuffer = await audioContext.decodeAudioData(arrayBuffer);

  const rawDataL = audioBuffer.getChannelData(0);
  const rawDataR = audioBuffer.numberOfChannels > 1 ? audioBuffer.getChannelData(1) : rawDataL;
  const sampleRate = audioBuffer.sampleRate;

  const chunkSize = Math.floor(sampleRate / 20); 
  let maxEnergy = 0;
  const chunkEnergies: number[] = [];

  for (let i = 0; i < rawDataL.length; i += chunkSize) {
    let chunkEnergy = 0;
    let count = 0;
    for (let j = i; j < i + chunkSize && j < rawDataL.length; j++) {
      chunkEnergy += (Math.abs(rawDataL[j]) + Math.abs(rawDataR[j])) / 2;
      count++;
    }
    chunkEnergy /= count;
    chunkEnergies.push(chunkEnergy);
    if (chunkEnergy > maxEnergy) maxEnergy = chunkEnergy;
  }

  const sortedEnergies = [...chunkEnergies].sort((a, b) => a - b);
  const percentile95 = sortedEnergies[Math.floor(sortedEnergies.length * 0.95)] || 0;
  maxEnergy = percentile95 > 0 ? percentile95 : maxEnergy;

  const thresholdPercent = 0.85 - ((sensitivity - 1) / 99) * 0.70;
  const threshold = maxEnergy * thresholdPercent;

  let lastNoteTime = -1;
  const beatmap: Note[] = [];
  const energyData: EnergyData[] = [];
  const activeLongNotesEndTime = [0, 0, 0, 0];
  
  let currentCumulativeDistance = 0;
  const BASE_SCROLL_SPEED = 700;
  let smoothedEnergy = 0;

  for (let c = 0; c < chunkEnergies.length; c++) {
    let chunkEnergy = chunkEnergies[c];
    let currentTime = (c * chunkSize) / sampleRate;

    let normalizedEnergy = maxEnergy > 0 ? chunkEnergy / maxEnergy : 0;
    // Boost sensitivity for medium-to-low volumes so they have more impact
    normalizedEnergy = Math.pow(normalizedEnergy, 0.6);
    if (normalizedEnergy > 1) normalizedEnergy = 1;
    
    let modeEnergy = 0;
    if (normalizedEnergy > 0.8) modeEnergy = 1.5;
    else if (normalizedEnergy > 0.6) modeEnergy = 0.8;
    else if (normalizedEnergy > 0.4) modeEnergy = 0.4;
    else if (normalizedEnergy > 0.2) modeEnergy = 0.0;
    else modeEnergy = -0.4;

    smoothedEnergy += (modeEnergy - smoothedEnergy) * 0.05;
    
    let currentScrollSpeed = BASE_SCROLL_SPEED + (smoothedEnergy * 400);
    let chunkDuration = chunkSize / sampleRate;
    currentCumulativeDistance += currentScrollSpeed * chunkDuration;

    // Normalize energy
    energyData.push({
      time: currentTime,
      energy: normalizedEnergy,
      cumulativeDistance: currentCumulativeDistance
    });

    let isLocalPeak = true;
    if (c > 0 && chunkEnergies[c - 1] >= chunkEnergy) isLocalPeak = false;
    if (c < chunkEnergies.length - 1 && chunkEnergies[c + 1] > chunkEnergy) isLocalPeak = false;

    if (chunkEnergy > threshold && isLocalPeak && (currentTime - lastNoteTime > 0.12)) {
      let availableLanes = [];
      for (let i = 0; i < 4; i++) {
        if (currentTime >= activeLongNotesEndTime[i]) {
          availableLanes.push(i);
        }
      }

      if (availableLanes.length > 0) {
        let isLongNote = false;
        let duration = 0;
        
        // To prevent distinct beats from merging into long notes, we abort if we detect a new sharp peak (transient).
        const sustainThreshold = Math.max(threshold * 0.85, chunkEnergy * 0.55);
        let forwardC = c + 1;
        let gapCount = 0;
        const maxGapChunks = 1; // tight gap tolerance
        
        while (forwardC < chunkEnergies.length) {
            let nextEnergy = chunkEnergies[forwardC];
            
            // Abort sustain if we detect a new attack transient (energy spikes up suddenly)
            if (forwardC > c + 1 && nextEnergy > chunkEnergies[forwardC - 1] * 1.3 && nextEnergy > threshold * 0.8) {
                break;
            }

            if (nextEnergy >= sustainThreshold) {
                gapCount = 0;
            } else {
                gapCount++;
                if (gapCount > maxGapChunks) {
                    forwardC -= gapCount;
                    break;
                }
            }
            forwardC++;
        }
        
        const possibleDuration = (forwardC - c - 1) * (chunkSize / sampleRate);
        if (possibleDuration > 0.3) {
            isLongNote = true;
            duration = Math.min(possibleDuration, 3.0);
        }

        const lane = availableLanes[Math.floor(Math.random() * availableLanes.length)];
        
        if (isLongNote) {
           activeLongNotesEndTime[lane] = currentTime + duration;
        }
        
        beatmap.push({
          id: Math.random().toString(36).substring(2, 9),
          time: currentTime,
          lane: lane,
          hit: false,
          missed: false,
          cumulativeDistance: currentCumulativeDistance,
          duration: duration
        });
        lastNoteTime = currentTime;
      }
    }
  }

  // Calculate cumulativeDistanceEnd for long notes
  if (energyData.length > 1) {
    const chunkDuration = energyData[1].time - energyData[0].time;
    for (let i = 0; i < beatmap.length; i++) {
      if (beatmap[i].duration && beatmap[i].duration! > 0) {
        const endTime = beatmap[i].time + beatmap[i].duration!;
        
        // Interpolate from energyData
        const exactIdx = endTime / chunkDuration;
        const idx1 = Math.floor(exactIdx);
        const idx2 = Math.min(idx1 + 1, energyData.length - 1);
        const t = exactIdx - idx1;
        
        if (energyData[idx1] && energyData[idx2]) {
          const dp1 = energyData[idx1];
          const dp2 = energyData[idx2];
          beatmap[i].cumulativeDistanceEnd = dp1.cumulativeDistance + (dp2.cumulativeDistance - dp1.cumulativeDistance) * t;
        } else {
          beatmap[i].cumulativeDistanceEnd = beatmap[i].cumulativeDistance! + beatmap[i].duration! * BASE_SCROLL_SPEED;
        }
      }
    }
  }

  return { buffer: audioBuffer, beatmap, energyData };
};

export const formatTime = (seconds: number) => {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s < 10 ? '0' : ''}${s}`;
};
