import React, { useState, useEffect, useCallback, useRef } from 'react';
import { db } from './firebase';
import { ref, set, onValue, update, push, get } from 'firebase/database';
import { motion, AnimatePresence } from 'motion/react';
import { 
  Users, 
  Plus, 
  LogIn, 
  Upload, 
  Play, 
  RotateCcw, 
  Image as ImageIcon,
  CheckCircle2,
  AlertCircle,
  Loader2,
  ChevronRight
} from 'lucide-react';
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

// --- Types ---

interface GameImage {
  id: string;
  url: string;
  isFlipped: boolean;
}

interface RoomState {
  id: string;
  pin: string;
  hostId: string;
  guestId?: string;
  status: 'lobby' | 'playing';
  createdAt: number;
  lastActive: number;
  // Signaling for WebRTC
  signal?: {
    offer?: any;
    answer?: any;
    hostCandidates?: any[];
    guestCandidates?: any[];
  };
}

// --- Components ---

export default function App() {
  const [userId] = useState(() => Math.random().toString(36).substring(7));
  const [room, setRoom] = useState<RoomState | null>(null);
  const [localImages, setLocalImages] = useState<Record<string, GameImage>>({});
  const [pin, setPin] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  // WebRTC Refs
  const pcRef = useRef<RTCPeerConnection | null>(null);
  const dcRef = useRef<RTCDataChannel | null>(null);
  const [connectionStatus, setConnectionStatus] = useState<'disconnected' | 'connecting' | 'connected'>('disconnected');

  // --- WebRTC Logic ---

  const setupPeerConnection = useCallback(() => {
    const pc = new RTCPeerConnection({
      iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
    });

    pc.onicecandidate = (event) => {
      if (event.candidate && room?.id) {
        const role = room.hostId === userId ? 'host' : 'guest';
        const candidatesRef = ref(db, `rooms/${room.id}/signal/${role}Candidates`);
        // Store candidate as plain object
        const candidateData = {
          candidate: event.candidate.candidate,
          sdpMid: event.candidate.sdpMid,
          sdpMLineIndex: event.candidate.sdpMLineIndex,
          usernameFragment: event.candidate.usernameFragment
        };
        push(candidatesRef, candidateData);
      }
    };

    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'connected') setConnectionStatus('connected');
      if (pc.connectionState === 'disconnected' || pc.connectionState === 'failed') setConnectionStatus('disconnected');
    };

    pcRef.current = pc;
    return pc;
  }, [room?.id, room?.hostId, userId]);

  // Host Logic: Create Offer
  useEffect(() => {
    if (room && room.hostId === userId && room.guestId && !room.signal?.offer) {
      const startSignaling = async () => {
        const pc = setupPeerConnection();
        const dc = pc.createDataChannel('imageTransfer');
        dcRef.current = dc;

        dc.onopen = () => {
          console.log("Data channel open! Sending images...");
          if (Object.keys(localImages).length > 0) {
            const data = JSON.stringify({ type: 'IMAGES', data: localImages });
            const chunkSize = 16384; // 16KB chunks
            for (let i = 0; i < data.length; i += chunkSize) {
              const chunk = data.slice(i, i + chunkSize);
              dc.send(JSON.stringify({ 
                type: 'CHUNK', 
                data: chunk, 
                isLast: i + chunkSize >= data.length 
              }));
            }
          }
        };

        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        await update(ref(db, `rooms/${room.id}/signal`), { offer: offer.toJSON() });
      };
      startSignaling();
    }
  }, [room?.guestId, room?.hostId, userId, setupPeerConnection, localImages]);

  // Guest Logic: Handle Offer & Create Answer
  useEffect(() => {
    if (room && room.guestId === userId && room.signal?.offer && !room.signal?.answer) {
      const handleOffer = async () => {
        const pc = setupPeerConnection();
        
        pc.ondatachannel = (event) => {
          const dc = event.channel;
          dcRef.current = dc;
          let receivedData = '';
          
          dc.onmessage = (e) => {
            const msg = JSON.parse(e.data);
            if (msg.type === 'CHUNK') {
              receivedData += msg.data;
              if (msg.isLast) {
                const fullData = JSON.parse(receivedData);
                if (fullData.type === 'IMAGES') {
                  setLocalImages(fullData.data);
                }
                receivedData = '';
              }
            }
          };
        };

        await pc.setRemoteDescription(new RTCSessionDescription(room.signal!.offer));
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        await update(ref(db, `rooms/${room.id}/signal`), { answer: answer.toJSON() });
      };
      handleOffer();
    }
  }, [room?.signal?.offer, room?.guestId, userId, setupPeerConnection]);

  // Both: Handle Answer
  useEffect(() => {
    if (room && room.hostId === userId && room.signal?.answer && pcRef.current?.signalingState === 'have-local-offer') {
      pcRef.current.setRemoteDescription(new RTCSessionDescription(room.signal.answer));
    }
  }, [room?.signal?.answer, room?.hostId, userId]);

  // Both: Handle ICE Candidates
  useEffect(() => {
    if (!room?.id || !pcRef.current) return;
    const role = room.hostId === userId ? 'guest' : 'host';
    const candidatesRef = ref(db, `rooms/${room.id}/signal/${role}Candidates`);
    
    const unsubscribe = onValue(candidatesRef, (snapshot) => {
      const data = snapshot.val();
      if (data && pcRef.current?.remoteDescription) {
        Object.values(data).forEach((candidate: any) => {
          pcRef.current?.addIceCandidate(new RTCIceCandidate(candidate))
            .catch(e => console.error("Error adding ICE candidate", e));
        });
      }
    });
    return () => unsubscribe();
  }, [room?.id, room?.hostId, userId]);

  // Sync images over data channel when they change
  useEffect(() => {
    if (dcRef.current?.readyState === 'open' && room?.hostId === userId) {
      const data = JSON.stringify({ type: 'IMAGES', data: localImages });
      const chunkSize = 16384;
      for (let i = 0; i < data.length; i += chunkSize) {
        const chunk = data.slice(i, i + chunkSize);
        dcRef.current.send(JSON.stringify({ 
          type: 'CHUNK', 
          data: chunk, 
          isLast: i + chunkSize >= data.length 
        }));
      }
    }
  }, [localImages, room?.hostId, userId]);

  // Cleanup old rooms (older than 1 hour)
  const cleanupOldRooms = useCallback(async () => {
    try {
      const roomsRef = ref(db, 'rooms');
      const snapshot = await get(roomsRef);
      const rooms = snapshot.val();
      if (!rooms) return;

      const now = Date.now();
      const oneHour = 60 * 60 * 1000;
      const updates: Record<string, null> = {};

      Object.keys(rooms).forEach((id) => {
        const room = rooms[id];
        const lastActive = room.lastActive || room.createdAt;
        if (now - lastActive > oneHour) {
          updates[`rooms/${id}`] = null;
        }
      });

      if (Object.keys(updates).length > 0) {
        await update(ref(db), updates);
        console.log(`Cleaned up ${Object.keys(updates).length} inactive rooms.`);
      }
    } catch (err) {
      console.error("Cleanup failed:", err);
    }
  }, []);

  useEffect(() => {
    cleanupOldRooms();
  }, [cleanupOldRooms]);

  // Listen for room updates
  useEffect(() => {
    if (!room?.id) return;

    const roomRef = ref(db, `rooms/${room.id}`);
    const unsubscribe = onValue(roomRef, (snapshot) => {
      const data = snapshot.val();
      if (data) {
        setRoom(data);
      } else {
        setRoom(null);
        setError("Room no longer exists.");
      }
    });

    return () => unsubscribe();
  }, [room?.id]);

  const createRoom = async () => {
    setLoading(true);
    setError(null);
    try {
      const newPin = Math.floor(100000 + Math.random() * 900000).toString();
      const roomRef = push(ref(db, 'rooms'));
      const roomId = roomRef.key!;
      
      const initialRoom: RoomState = {
        id: roomId,
        pin: newPin,
        hostId: userId,
        status: 'lobby',
        createdAt: Date.now(),
        lastActive: Date.now(),
      };

      await set(roomRef, initialRoom);
      setRoom(initialRoom);
    } catch (err) {
      setError("Failed to create room. Check your Firebase config.");
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  const joinRoom = async () => {
    if (!pin || pin.length < 6) {
      setError("Please enter a valid 6-digit PIN.");
      return;
    }

    setLoading(true);
    setError(null);
    try {
      const roomsRef = ref(db, 'rooms');
      const snapshot = await get(roomsRef);
      const rooms = snapshot.val();
      
      let foundRoomId: string | null = null;
      if (rooms) {
        for (const id in rooms) {
          if (rooms[id].pin === pin) {
            foundRoomId = id;
            break;
          }
        }
      }

      if (foundRoomId) {
        const roomRef = ref(db, `rooms/${foundRoomId}`);
        await update(roomRef, { 
          guestId: userId,
          lastActive: Date.now()
        });
        const updatedSnapshot = await get(roomRef);
        setRoom(updatedSnapshot.val());
      } else {
        setError("Room not found. Check the PIN.");
      }
    } catch (err) {
      setError("Failed to join room.");
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  const leaveRoom = async () => {
    if (room) {
      try {
        const roomRef = ref(db, `rooms/${room.id}`);
        if (room.hostId === userId) {
          // Host leaves: delete the entire room
          await set(roomRef, null);
        } else if (room.guestId === userId) {
          // Guest leaves: remove guest and reset to lobby
          await update(roomRef, { 
            guestId: null,
            status: 'lobby',
            lastActive: Date.now()
          });
        }
      } catch (err) {
        console.error("Error leaving room:", err);
      }
    }
    setRoom(null);
    setPin('');
    setError(null);
  };

  if (!room) {
    return (
      <div className="min-h-screen bg-[#f5f5f5] flex items-center justify-center p-6 font-sans">
        <motion.div 
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          className="w-full max-w-md bg-white rounded-3xl shadow-xl p-8 border border-black/5"
        >
          <div className="flex flex-col items-center mb-8">
            <div className="w-16 h-16 bg-indigo-600 rounded-2xl flex items-center justify-center mb-4 shadow-lg shadow-indigo-200">
              <Users className="text-white w-8 h-8" />
            </div>
            <h1 className="text-3xl font-bold text-gray-900 tracking-tight">Guess Who</h1>
            <p className="text-gray-500 mt-2 text-center">Real-time image guessing game</p>
          </div>

          <div className="space-y-6">
            <div className="space-y-3">
              <button
                onClick={createRoom}
                disabled={loading}
                className="w-full bg-indigo-600 hover:bg-indigo-700 text-white font-semibold py-4 rounded-2xl transition-all flex items-center justify-center gap-2 shadow-md hover:shadow-lg disabled:opacity-50"
              >
                {loading ? <Loader2 className="animate-spin" /> : <Plus size={20} />}
                Create New Room
              </button>
            </div>

            <div className="relative py-4">
              <div className="absolute inset-0 flex items-center">
                <div className="w-full border-t border-gray-200"></div>
              </div>
              <div className="relative flex justify-center text-sm">
                <span className="px-4 bg-white text-gray-400 uppercase tracking-widest font-medium">or join one</span>
              </div>
            </div>

            <div className="space-y-4">
              <div className="relative">
                <input
                  type="text"
                  placeholder="Enter 6-digit PIN"
                  value={pin}
                  onChange={(e) => setPin(e.target.value.replace(/\D/g, '').slice(0, 6))}
                  className="w-full bg-gray-50 border-2 border-transparent focus:border-indigo-500 focus:bg-white rounded-2xl py-4 px-6 text-center text-2xl font-mono tracking-[0.5em] transition-all outline-none"
                />
              </div>
              <button
                onClick={joinRoom}
                disabled={loading || pin.length < 6}
                className="w-full bg-white border-2 border-indigo-600 text-indigo-600 hover:bg-indigo-50 font-semibold py-4 rounded-2xl transition-all flex items-center justify-center gap-2 disabled:opacity-50 disabled:border-gray-300 disabled:text-gray-300"
              >
                <LogIn size={20} />
                Join Room
              </button>
            </div>

            {error && (
              <motion.div 
                initial={{ opacity: 0, scale: 0.95 }}
                animate={{ opacity: 1, scale: 1 }}
                className="p-4 bg-red-50 text-red-600 rounded-xl flex items-center gap-3 text-sm font-medium border border-red-100"
              >
                <AlertCircle size={18} className="shrink-0" />
                {error}
              </motion.div>
            )}
          </div>
        </motion.div>
      </div>
    );
  }

  return (
    <RoomView 
      room={room} 
      userId={userId} 
      onLeave={leaveRoom} 
      localImages={localImages}
      setLocalImages={setLocalImages}
      connectionStatus={connectionStatus}
    />
  );
}

// --- Room View Component ---

function RoomView({ 
  room, 
  userId, 
  onLeave, 
  localImages, 
  setLocalImages,
  connectionStatus
}: { 
  room: RoomState; 
  userId: string; 
  onLeave: () => void | Promise<void>;
  localImages: Record<string, GameImage>;
  setLocalImages: React.Dispatch<React.SetStateAction<Record<string, GameImage>>>;
  connectionStatus: string;
}) {
  const isHost = room.hostId === userId;
  const isGuest = room.guestId === userId;
  const isWaiting = !room.guestId;

  if (room.status === 'playing') {
    return (
      <GameBoard 
        room={room} 
        userId={userId} 
        onLeave={onLeave} 
        localImages={localImages}
      />
    );
  }

  return (
    <div className="min-h-screen bg-[#f5f5f5] p-6 font-sans">
      <div className="max-w-4xl mx-auto">
        <header className="flex items-center justify-between mb-8">
          <button 
            onClick={onLeave}
            className="text-gray-500 hover:text-gray-900 font-medium flex items-center gap-2 transition-colors"
          >
            <RotateCcw size={18} />
            Leave Room
          </button>
          <div className="bg-white px-6 py-2 rounded-full shadow-sm border border-black/5 flex items-center gap-3">
            <span className="text-xs font-bold text-gray-400 uppercase tracking-widest">Room PIN</span>
            <span className="text-xl font-mono font-bold text-indigo-600 tracking-wider">{room.pin}</span>
          </div>
        </header>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-8">
          {/* Players Card */}
          <div className="md:col-span-1 space-y-6">
            <div className="bg-white rounded-3xl shadow-sm border border-black/5 p-6">
              <h2 className="text-lg font-bold text-gray-900 mb-6 flex items-center gap-2">
                <Users size={20} className="text-indigo-600" />
                Players
              </h2>
              <div className="space-y-4">
                <div className="flex items-center justify-between p-4 bg-indigo-50 rounded-2xl border border-indigo-100">
                  <div className="flex items-center gap-3">
                    <div className="w-10 h-10 bg-indigo-600 rounded-full flex items-center justify-center text-white font-bold">H</div>
                    <div>
                      <p className="font-bold text-gray-900">Host</p>
                      <p className="text-xs text-indigo-600 font-medium">Room Creator</p>
                    </div>
                  </div>
                  {isHost && <span className="text-[10px] bg-indigo-200 text-indigo-800 px-2 py-0.5 rounded-full font-bold uppercase tracking-wider">You</span>}
                </div>

                {room.guestId ? (
                  <div className="flex items-center justify-between p-4 bg-emerald-50 rounded-2xl border border-emerald-100">
                    <div className="flex items-center gap-3">
                      <div className="w-10 h-10 bg-emerald-600 rounded-full flex items-center justify-center text-white font-bold">G</div>
                      <div>
                        <p className="font-bold text-gray-900">Guest</p>
                        <p className="text-xs text-emerald-600 font-medium">Connected</p>
                      </div>
                    </div>
                    {isGuest && <span className="text-[10px] bg-emerald-200 text-emerald-800 px-2 py-0.5 rounded-full font-bold uppercase tracking-wider">You</span>}
                  </div>
                ) : (
                  <div className="flex items-center gap-3 p-4 bg-gray-50 rounded-2xl border border-dashed border-gray-300">
                    <div className="w-10 h-10 bg-gray-200 rounded-full flex items-center justify-center text-gray-400">
                      <Loader2 className="animate-spin" size={20} />
                    </div>
                    <div>
                      <p className="font-bold text-gray-400">Waiting...</p>
                      <p className="text-xs text-gray-400">Share PIN to join</p>
                    </div>
                  </div>
                )}
              </div>
            </div>

            {isWaiting && (
              <div className="bg-indigo-600 rounded-3xl p-6 text-white shadow-lg shadow-indigo-200">
                <h3 className="font-bold text-lg mb-2">Invite a Friend</h3>
                <p className="text-indigo-100 text-sm leading-relaxed">
                  Share the 6-digit PIN with your opponent. Once they join, you can start uploading images for the game.
                </p>
              </div>
            )}
          </div>

          {/* Upload Card */}
          <div className="md:col-span-2">
            <div className="bg-white rounded-3xl shadow-sm border border-black/5 p-8 h-full">
              {isHost ? (
                <HostUploadArea 
                  room={room} 
                  localImages={localImages} 
                  setLocalImages={setLocalImages} 
                  connectionStatus={connectionStatus}
                />
              ) : (
                <div className="flex flex-col items-center justify-center h-full text-center py-12">
                  <div className="w-20 h-20 bg-gray-100 rounded-full flex items-center justify-center mb-6">
                    <ImageIcon size={32} className="text-gray-400" />
                  </div>
                  <h2 className="text-2xl font-bold text-gray-900 mb-3">Host is setting up</h2>
                  <p className="text-gray-500 max-w-sm">
                    The host is currently uploading images for the game. Hang tight, the game will start automatically!
                  </p>
                  <div className="mt-8 flex flex-col items-center gap-4">
                    <div className="flex items-center gap-2 text-indigo-600 font-medium">
                      <Loader2 className="animate-spin" size={18} />
                      <span>Waiting for images...</span>
                    </div>
                    <div className="flex items-center gap-2 text-[10px] font-bold uppercase tracking-wider">
                      <span className={cn(
                        "w-2 h-2 rounded-full",
                        connectionStatus === 'connected' ? "bg-emerald-500" : "bg-amber-500 animate-pulse"
                      )} />
                      <span className={connectionStatus === 'connected' ? "text-emerald-600" : "text-amber-600"}>
                        {connectionStatus === 'connected' ? "P2P Connected" : "Establishing Connection..."}
                      </span>
                    </div>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// --- Host Upload Area ---

function HostUploadArea({ 
  room, 
  localImages, 
  setLocalImages,
  connectionStatus
}: { 
  room: RoomState; 
  localImages: Record<string, GameImage>;
  setLocalImages: React.Dispatch<React.SetStateAction<Record<string, GameImage>>>;
  connectionStatus: string;
}) {
  const [uploading, setUploading] = useState(false);
  const [progress, setProgress] = useState(0);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const workerRef = useRef<Worker | null>(null);

  useEffect(() => {
    // Initialize Web Worker
    workerRef.current = new Worker(new URL('./imageWorker.ts', import.meta.url), { type: 'module' });
    
    return () => {
      workerRef.current?.terminate();
    };
  }, []);

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []) as File[];
    if (files.length === 0) return;

    setUploading(true);
    setProgress(0);

    const newLocalImages: Record<string, GameImage> = { ...localImages };
    const total = files.length;

    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      
      try {
        const base64 = await compressImage(file);
        const id = Math.random().toString(36).substring(7);
        newLocalImages[id] = {
          id,
          url: base64,
          isFlipped: false
        };
        setProgress(Math.round(((i + 1) / total) * 100));
      } catch (err) {
        console.error("Compression failed for file:", file.name, err);
      }
    }

    setLocalImages(newLocalImages);
    setUploading(false);
  };

  const compressImage = (file: File): Promise<string> => {
    return new Promise((resolve, reject) => {
      if (!workerRef.current) return reject("Worker not initialized");

      workerRef.current.onmessage = (e) => {
        if (e.data.success) {
          resolve(e.data.base64);
        } else {
          reject(e.data.error);
        }
      };

      workerRef.current.postMessage({ file, maxSize: 2 * 1024 * 1024 }); // 2MB
    });
  };

  const startGame = async () => {
    if (Object.keys(localImages).length < 2) return;
    await update(ref(db, `rooms/${room.id}`), { 
      status: 'playing',
      lastActive: Date.now()
    });
  };

  const removeImage = (id: string) => {
    const newImages = { ...localImages };
    delete newImages[id];
    setLocalImages(newImages);
  };

  const imageCount = Object.keys(localImages).length;

  return (
    <div className="space-y-8">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold text-gray-900">Game Setup</h2>
          <p className="text-gray-500 mt-1">Upload images for the game board</p>
        </div>
        <div className="flex items-center gap-2 bg-indigo-50 text-indigo-700 px-4 py-2 rounded-full font-bold text-sm">
          <ImageIcon size={16} />
          {imageCount} Images
        </div>
      </div>

      <div 
        onClick={() => !uploading && fileInputRef.current?.click()}
        className={cn(
          "border-2 border-dashed rounded-3xl p-12 flex flex-col items-center justify-center transition-all cursor-pointer",
          uploading ? "bg-gray-50 border-gray-200 cursor-not-allowed" : "bg-indigo-50/30 border-indigo-200 hover:border-indigo-400 hover:bg-indigo-50/50"
        )}
      >
        <input 
          type="file" 
          multiple 
          accept="image/*" 
          className="hidden" 
          ref={fileInputRef}
          onChange={handleFileChange}
          disabled={uploading}
        />
        
        {uploading ? (
          <div className="text-center space-y-4 w-full max-w-xs">
            <div className="relative h-2 bg-gray-200 rounded-full overflow-hidden">
              <motion.div 
                initial={{ width: 0 }}
                animate={{ width: `${progress}%` }}
                className="absolute inset-0 bg-indigo-600"
              />
            </div>
            <p className="text-sm font-bold text-gray-600">Compressing & Uploading... {progress}%</p>
          </div>
        ) : (
          <>
            <div className="w-16 h-16 bg-white rounded-2xl shadow-sm flex items-center justify-center mb-4 border border-indigo-100">
              <Upload className="text-indigo-600" />
            </div>
            <p className="font-bold text-gray-900 mb-1">Click to upload images</p>
            <p className="text-sm text-gray-500">PNG, JPG, GIF up to 10MB each</p>
          </>
        )}
      </div>

      {imageCount > 0 && (
        <div className="space-y-6">
          <div className="grid grid-cols-4 sm:grid-cols-6 gap-3">
            <AnimatePresence>
              {Object.values(localImages).map((img) => (
                <motion.div 
                  key={img.id}
                  initial={{ opacity: 0, scale: 0.8 }}
                  animate={{ opacity: 1, scale: 1 }}
                  exit={{ opacity: 0, scale: 0.8 }}
                  className="relative aspect-square rounded-xl overflow-hidden group border border-black/5"
                >
                  <img src={img.url} className="w-full h-full object-cover" referrerPolicy="no-referrer" />
                  <button 
                    onClick={() => removeImage(img.id)}
                    className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center text-white"
                  >
                    <Plus className="rotate-45" size={20} />
                  </button>
                </motion.div>
              ))}
            </AnimatePresence>
          </div>

          <div className="pt-6 border-t border-gray-100 flex items-center justify-between">
            <div className="flex flex-col gap-1">
              <div className="flex items-center gap-2 text-sm font-medium text-gray-500">
                {imageCount < 2 ? (
                  <><AlertCircle size={16} className="text-amber-500" /> Upload at least 2 images</>
                ) : (
                  <><CheckCircle2 size={16} className="text-emerald-500" /> Ready to play!</>
                )}
              </div>
              <div className="flex items-center gap-2 text-[10px] font-bold uppercase tracking-wider">
                <span className={cn(
                  "w-2 h-2 rounded-full",
                  connectionStatus === 'connected' ? "bg-emerald-500" : "bg-amber-500 animate-pulse"
                )} />
                <span className={connectionStatus === 'connected' ? "text-emerald-600" : "text-amber-600"}>
                  {connectionStatus === 'connected' ? "P2P Connected" : "Waiting for Peer..."}
                </span>
              </div>
            </div>
            <button
              onClick={startGame}
              disabled={imageCount < 2 || !room.guestId || connectionStatus !== 'connected'}
              className="bg-indigo-600 hover:bg-indigo-700 disabled:bg-gray-200 disabled:text-gray-400 text-white font-bold px-8 py-3 rounded-2xl transition-all flex items-center gap-2 shadow-lg shadow-indigo-200 disabled:shadow-none"
            >
              Start Game
              <ChevronRight size={18} />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// --- Game Board Component ---

function GameBoard({ 
  room, 
  userId, 
  onLeave, 
  localImages 
}: { 
  room: RoomState; 
  userId: string; 
  onLeave: () => void | Promise<void>;
  localImages: Record<string, GameImage>;
}) {
  const [flippedStates, setFlippedStates] = useState<Record<string, boolean>>({});

  useEffect(() => {
    const flippedRef = ref(db, `rooms/${room.id}/flipped`);
    const unsubscribe = onValue(flippedRef, (snapshot) => {
      setFlippedStates(snapshot.val() || {});
    });
    return () => unsubscribe();
  }, [room.id]);

  const toggleFlip = async (id: string) => {
    const currentFlipped = flippedStates[id] || false;
    await update(ref(db, `rooms/${room.id}`), {
      [`flipped/${id}`]: !currentFlipped,
      lastActive: Date.now()
    });
  };

  const resetBoard = async () => {
    await set(ref(db, `rooms/${room.id}/flipped`), null);
    await update(ref(db, `rooms/${room.id}`), { lastActive: Date.now() });
  };

  const images = Object.values(localImages).map(img => ({
    ...img,
    isFlipped: flippedStates[img.id] || false
  }));

  return (
    <div className="min-h-screen bg-[#0f172a] p-6 font-sans text-white">
      <div className="max-w-6xl mx-auto h-full flex flex-col">
        <header className="flex items-center justify-between mb-8">
          <div className="flex items-center gap-4">
            <div className="w-12 h-12 bg-indigo-600 rounded-xl flex items-center justify-center shadow-lg shadow-indigo-500/20">
              <Play className="fill-white" size={20} />
            </div>
            <div>
              <h1 className="text-xl font-bold tracking-tight">Guess Who</h1>
              <p className="text-xs text-slate-400 font-medium uppercase tracking-widest">Live Match</p>
            </div>
          </div>

          <div className="flex items-center gap-3">
            <button 
              onClick={resetBoard}
              className="bg-slate-800 hover:bg-slate-700 text-slate-300 px-4 py-2 rounded-xl text-sm font-bold transition-colors flex items-center gap-2"
            >
              <RotateCcw size={16} />
              Reset
            </button>
            <button 
              onClick={onLeave}
              className="bg-red-500/10 hover:bg-red-500/20 text-red-400 px-4 py-2 rounded-xl text-sm font-bold transition-colors"
            >
              Exit
            </button>
          </div>
        </header>

        <div className="flex-1">
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-4">
            {images.map((img) => (
              <GameCard 
                key={img.id} 
                image={img} 
                onClick={() => toggleFlip(img.id)} 
              />
            ))}
          </div>
        </div>

        <footer className="mt-12 p-6 bg-slate-800/50 rounded-3xl border border-slate-700/50 flex items-center justify-between">
          <div className="flex items-center gap-6">
            <div className="flex items-center gap-3">
              <div className="w-8 h-8 bg-indigo-600 rounded-full flex items-center justify-center text-xs font-bold">H</div>
              <span className="text-sm font-medium text-slate-300">Host</span>
            </div>
            <div className="w-px h-4 bg-slate-700"></div>
            <div className="flex items-center gap-3">
              <div className="w-8 h-8 bg-emerald-600 rounded-full flex items-center justify-center text-xs font-bold">G</div>
              <span className="text-sm font-medium text-slate-300">Guest</span>
            </div>
          </div>
          <div className="text-xs font-bold text-slate-500 uppercase tracking-widest">
            {images.filter(i => i.isFlipped).length} / {images.length} Flipped
          </div>
        </footer>
      </div>
    </div>
  );
}

const GameCard: React.FC<{ image: GameImage; onClick: () => void | Promise<void> }> = ({ image, onClick }) => {
  return (
    <div 
      onClick={onClick}
      className="relative aspect-[3/4] cursor-pointer perspective-1000 group"
    >
      <motion.div
        animate={{ rotateY: image.isFlipped ? 180 : 0 }}
        transition={{ type: "spring", stiffness: 260, damping: 20 }}
        className="w-full h-full relative preserve-3d"
      >
        {/* Front */}
        <div className="absolute inset-0 backface-hidden rounded-2xl overflow-hidden border-4 border-slate-800 shadow-xl">
          <img 
            src={image.url} 
            className="w-full h-full object-cover" 
            referrerPolicy="no-referrer"
            alt="Game character"
          />
          <div className="absolute inset-0 bg-gradient-to-t from-black/60 via-transparent to-transparent opacity-0 group-hover:opacity-100 transition-opacity" />
        </div>

        {/* Back */}
        <div className="absolute inset-0 backface-hidden rotate-y-180 rounded-2xl bg-indigo-600 flex flex-col items-center justify-center p-4 border-4 border-indigo-400 shadow-xl">
          <div className="w-12 h-12 bg-white/20 rounded-full flex items-center justify-center mb-2">
            <ImageIcon className="text-white/40" size={24} />
          </div>
          <div className="w-full h-1 bg-white/10 rounded-full mb-1" />
          <div className="w-2/3 h-1 bg-white/10 rounded-full" />
        </div>
      </motion.div>
    </div>
  );
}
