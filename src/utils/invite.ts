export const ROOM_CODE_PATTERN = /^[A-HJ-NP-Z2-9]{6}$/;

export const normalizeRoomCode = (value: string): string =>
  value.trim().toUpperCase().replace(/[^A-HJ-NP-Z2-9]/g, '').slice(0, 6);

export const roomCodeFromSearch = (search: string): string | null => {
  const value = new URLSearchParams(search).get('room');
  if (!value) return null;
  const roomCode = normalizeRoomCode(value);
  return ROOM_CODE_PATTERN.test(roomCode) ? roomCode : null;
};

export const createInviteUrl = (baseUrl: string, roomCode: string): string => {
  const normalizedRoomCode = normalizeRoomCode(roomCode);
  if (!ROOM_CODE_PATTERN.test(normalizedRoomCode)) {
    throw new RangeError('A valid room code is required to create an invite link.');
  }

  const inviteUrl = new URL(baseUrl);
  inviteUrl.search = '';
  inviteUrl.hash = '';
  inviteUrl.searchParams.set('room', normalizedRoomCode);
  return inviteUrl.toString();
};

export const isLoopbackHostname = (hostname: string): boolean => {
  const normalizedHostname = hostname.trim().toLowerCase();
  return normalizedHostname === 'localhost'
    || normalizedHostname === '127.0.0.1'
    || normalizedHostname === '::1'
    || normalizedHostname === '[::1]';
};
