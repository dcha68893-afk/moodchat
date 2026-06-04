const webrtc = require('../../../src/utils/webrtc');

describe('WebRTC Utility', () => {
  describe('generateRTCPeerConnectionConfig', () => {
    test('should generate default config', () => {
      const config = webrtc.generateRTCPeerConnectionConfig();
      
      expect(config).toHaveProperty('iceServers');
      expect(config.iceServers).toBeInstanceOf(Array);
      expect(config.iceServers[0]).toHaveProperty('urls');
    });

    test('should accept custom ICE servers', () => {
      const customServers = [{ urls: 'stun:custom.com:19302' }];
      const config = webrtc.generateRTCPeerConnectionConfig(customServers);
      
      expect(config.iceServers).toEqual(customServers);
    });
  });

  describe('createPeerConnection', () => {
    beforeEach(() => {
      global.RTCPeerConnection = jest.fn().mockImplementation(() => ({
        createOffer: jest.fn(),
        createAnswer: jest.fn(),
        setLocalDescription: jest.fn(),
        setRemoteDescription: jest.fn(),
        addIceCandidate: jest.fn(),
        addTrack: jest.fn(),
        close: jest.fn(),
        onicecandidate: null,
        onnegotiationneeded: null,
        oniceconnectionstatechange: null,
        ontrack: null
      }));
    });

    afterEach(() => {
      delete global.RTCPeerConnection;
    });

    test('should create RTCPeerConnection instance', () => {
      const pc = webrtc.createPeerConnection();
      
      expect(pc).toBeDefined();
      expect(RTCPeerConnection).toHaveBeenCalled();
    });
  });

  describe('createDataChannel', () => {
    test('should create data channel on peer connection', () => {
      const mockPC = {
        createDataChannel: jest.fn().mockReturnValue({
          onopen: null,
          onmessage: null,
          onclose: null
        })
      };

      const channel = webrtc.createDataChannel(mockPC, 'test-channel');
      
      expect(channel).toBeDefined();
      expect(mockPC.createDataChannel).toHaveBeenCalledWith('test-channel', { ordered: true });
    });
  });

  describe('createOffer', () => {
    test('should create offer with options', async () => {
      const mockPC = {
        createOffer: jest.fn().mockResolvedValue({ type: 'offer', sdp: 'test-sdp' }),
        setLocalDescription: jest.fn().mockResolvedValue()
      };

      const offer = await webrtc.createOffer(mockPC);
      
      expect(offer).toEqual({ type: 'offer', sdp: 'test-sdp' });
      expect(mockPC.setLocalDescription).toHaveBeenCalled();
    });

    test('should handle errors', async () => {
      const mockPC = {
        createOffer: jest.fn().mockRejectedValue(new Error('Failed'))
      };

      await expect(webrtc.createOffer(mockPC)).rejects.toThrow('Failed');
    });
  });

  describe('createAnswer', () => {
    test('should create answer for offer', async () => {
      const mockPC = {
        setRemoteDescription: jest.fn().mockResolvedValue(),
        createAnswer: jest.fn().mockResolvedValue({ type: 'answer', sdp: 'test-sdp' }),
        setLocalDescription: jest.fn().mockResolvedValue()
      };

      const offer = { type: 'offer', sdp: 'remote-sdp' };
      const answer = await webrtc.createAnswer(mockPC, offer);
      
      expect(answer).toEqual({ type: 'answer', sdp: 'test-sdp' });
      expect(mockPC.setRemoteDescription).toHaveBeenCalledWith(offer);
    });
  });

  describe('addIceCandidate', () => {
    test('should add ICE candidate', async () => {
      const mockPC = {
        addIceCandidate: jest.fn().mockResolvedValue()
      };

      const candidate = {
        candidate: 'candidate:123',
        sdpMid: '0',
        sdpMLineIndex: 0
      };

      await webrtc.addIceCandidate(mockPC, candidate);
      expect(mockPC.addIceCandidate).toHaveBeenCalledWith(candidate);
    });

    test('should handle null candidate', async () => {
      const mockPC = { addIceCandidate: jest.fn() };
      await webrtc.addIceCandidate(mockPC, null);
      expect(mockPC.addIceCandidate).not.toHaveBeenCalled();
    });
  });

  describe('generateICEConfig', () => {
    test('should generate ICE server config', () => {
      const config = webrtc.generateICEConfig({
        stunServers: ['stun:stun1.example.com'],
        turnServers: [{
          urls: 'turn:turn.example.com',
          username: 'user',
          credential: 'pass'
        }]
      });

      expect(config).toHaveLength(2);
      expect(config[0]).toHaveProperty('urls', 'stun:stun1.example.com');
      expect(config[1]).toHaveProperty('username', 'user');
    });
  });

  describe('validateSDP', () => {
    test('should validate SDP format', () => {
      const validSDP = 'v=0\r\no=- 123 2 IN IP4 127.0.0.1\r\ns=-\r\n';
      expect(webrtc.validateSDP(validSDP)).toBe(true);
      expect(webrtc.validateSDP('invalid')).toBe(false);
      expect(webrtc.validateSDP('')).toBe(false);
    });
  });

  describe('parseCandidate', () => {
    test('should parse ICE candidate string', () => {
      const candidateStr = 'candidate:123 1 udp 123456 192.168.1.1 12345 typ host';
      const parsed = webrtc.parseCandidate(candidateStr);
      
      expect(parsed).toHaveProperty('foundation', '123');
      expect(parsed).toHaveProperty('component', '1');
      expect(parsed).toHaveProperty('type', 'host');
    });

    test('should return null for invalid candidate', () => {
      expect(webrtc.parseCandidate('invalid')).toBeNull();
    });
  });

  describe('getConnectionState', () => {
    test('should map connection states', () => {
      expect(webrtc.getConnectionState('new')).toBe('new');
      expect(webrtc.getConnectionState('checking')).toBe('connecting');
      expect(webrtc.getConnectionState('connected')).toBe('connected');
      expect(webrtc.getConnectionState('disconnected')).toBe('disconnected');
      expect(webrtc.getConnectionState('failed')).toBe('failed');
      expect(webrtc.getConnectionState('closed')).toBe('closed');
      expect(webrtc.getConnectionState('unknown')).toBe('unknown');
    });
  });

  describe('closePeerConnection', () => {
    test('should close peer connection', () => {
      const mockPC = {
        close: jest.fn(),
        getSenders: jest.fn().mockReturnValue([{ track: { stop: jest.fn() } }])
      };

      webrtc.closePeerConnection(mockPC);
      
      expect(mockPC.close).toHaveBeenCalled();
    });
  });
});