
import React, { useState, useEffect, useRef } from 'react';
import { liveApiService } from '../services/liveApiService';
import { Share2, Volume2, VolumeX, MessageCircle, ArrowLeft, Loader2, Store, Clock, Play, CloudOff } from 'lucide-react';

interface ShowcaseItem {
    id: string;
    url: string;
    type: string;
    filename: string;
}

// Fallback S3 Bucket Base URL (Production Resilience)
// This should match the BUCKET_NAME in server.js
const FALLBACK_BUCKET_URL = "https://uber-fleet-assets.s3.amazonaws.com";

const VideoPlayer = ({ src, isActive, isMuted }: { src: string, isActive: boolean, isMuted: boolean }) => {
    const videoRef = useRef<HTMLVideoElement>(null);
    const [isPlaying, setIsPlaying] = useState(false);

    useEffect(() => {
        if (videoRef.current) {
            if (isActive) {
                videoRef.current.currentTime = 0;
                // Attempt play; catch autoplay policies error
                const playPromise = videoRef.current.play();
                if (playPromise !== undefined) {
                    playPromise
                        .then(() => setIsPlaying(true))
                        .catch(e => {
                            console.log("Autoplay prevented", e);
                            setIsPlaying(false);
                        });
                }
            } else {
                videoRef.current.pause();
                setIsPlaying(false);
            }
        }
    }, [isActive]);

    const handleTogglePlay = (e: React.MouseEvent) => {
        e.stopPropagation(); // Prevent parent clicks (like swipe triggers)
        if (videoRef.current) {
            if (videoRef.current.paused) {
                videoRef.current.play();
                // State will update via onPlay event
            } else {
                videoRef.current.pause();
                // State will update via onPause event
            }
        }
    };

    return (
        <div className="relative h-full w-full flex items-center justify-center cursor-pointer group" onClick={handleTogglePlay}>
            <video 
                ref={videoRef}
                src={src}
                className="h-full w-full object-contain rounded-2xl shadow-2xl z-10 bg-black"
                loop
                muted={isMuted}
                playsInline
                onPlay={() => setIsPlaying(true)}
                onPause={() => setIsPlaying(false)}
            />
            
            {/* PAUSE OVERLAY: Shows when paused */}
            {!isPlaying && (
                <div className="absolute inset-0 z-20 flex items-center justify-center bg-black/20 backdrop-blur-[1px] rounded-2xl transition-all">
                    <div className="bg-white/20 border border-white/30 backdrop-blur-md p-6 rounded-full shadow-2xl transform transition-transform scale-100 hover:scale-110">
                        <Play size={40} className="text-white fill-white ml-2" />
                    </div>
                </div>
            )}
        </div>
    );
};

export const PublicShowcase = ({ folderName }: { folderName?: string }) => {
    const [items, setItems] = useState<ShowcaseItem[]>([]);
    const [title, setTitle] = useState('');
    const [loading, setLoading] = useState(true);
    const [activeIndex, setActiveIndex] = useState(0);
    const [isMuted, setIsMuted] = useState(true); // Default muted for auto-play compatibility
    const [isOfflineMode, setIsOfflineMode] = useState(false);
    const containerRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        const loadShowcase = async () => {
            const cacheKey = `showcase_v1_${folderName || 'root'}`;
            let loadedFromCache = false;
            
            // 1. STRATEGY: Cache-First for Instant Load & Offline Support
            const cachedData = localStorage.getItem(cacheKey);

            if (cachedData) {
                try {
                    const parsed = JSON.parse(cachedData);
                    if (parsed.items && parsed.items.length > 0) {
                        setItems(parsed.items);
                        setTitle(parsed.title);
                        setLoading(false); // Render immediately
                        loadedFromCache = true;
                    }
                } catch(e) { console.error("Cache parse error", e); }
            }

            try {
                // 2. Fetch Fresh Data (API Strategy)
                const data = await liveApiService.getPublicShowcase(folderName);
                
                if (data && data.items) {
                    setItems(data.items);
                    setTitle(data.title || 'Showcase');
                    setIsOfflineMode(false); // We are online
                    localStorage.setItem(cacheKey, JSON.stringify(data));
                }
            } catch (e) {
                console.warn("Primary API Failed. Attempting S3 Manifest Fallback...", e);
                
                // 3. FALLBACK STRATEGY: Fetch Static JSON from S3
                // If API is down, we try to get the manifest directly from the bucket
                const manifestName = folderName ? `${encodeURIComponent(folderName)}.json` : `latest.json`;
                // Add timestamp to bust browser cache for S3 objects
                const s3Url = `${FALLBACK_BUCKET_URL}/manifests/${manifestName}?t=${Date.now()}`;

                try {
                    const s3Res = await fetch(s3Url);
                    if (s3Res.ok) {
                        const s3Data = await s3Res.json();
                        setItems(s3Data.items || []);
                        setTitle(s3Data.title || 'Showcase (Archive)');
                        setIsOfflineMode(true);
                        // Update cache with S3 data
                        localStorage.setItem(cacheKey, JSON.stringify(s3Data));
                    } else {
                        // If both API and S3 fail, stick with cache if we have it
                        if (!loadedFromCache) throw new Error("S3 Manifest not found");
                    }
                } catch (s3Err) {
                    console.error("S3 Fallback failed", s3Err);
                    // If everything fails and we have cache, we are fine.
                    // If no cache, we show empty state.
                }
            } finally {
                setLoading(false);
            }
        };
        
        loadShowcase();
    }, [folderName]);

    const handleScroll = () => {
        if (!containerRef.current) return;
        const index = Math.round(containerRef.current.scrollTop / containerRef.current.clientHeight);
        if (index !== activeIndex) setActiveIndex(index);
    };

    const handleWhatsAppReturn = () => {
        if (document.referrer.includes('whatsapp')) {
             window.history.back();
        } else {
             window.location.href = "https://wa.me/"; 
        }
    };

    if (loading) {
        return (
            <div className="h-[100dvh] w-full bg-black flex items-center justify-center">
                <div className="flex flex-col items-center gap-4">
                    <div className="animate-spin rounded-full h-12 w-12 border-t-2 border-b-2 border-white"></div>
                    <p className="text-white text-xs font-mono animate-pulse">Loading showroom...</p>
                </div>
            </div>
        );
    }

    if (items.length === 0) {
        return (
            <div className="h-[100dvh] w-full bg-neutral-900 text-white flex flex-col items-center justify-center p-8 text-center relative overflow-hidden">
                <div className="absolute inset-0 bg-[url('https://images.unsplash.com/photo-1492144534655-ae79c964c9d7?q=80&w=2000&auto=format&fit=crop')] bg-cover bg-center opacity-10"></div>
                <div className="z-10 bg-black/40 backdrop-blur-xl p-10 rounded-2xl border border-white/10 shadow-2xl flex flex-col items-center max-w-md">
                    <div className="bg-white/10 p-4 rounded-full mb-6">
                         <Store size={40} className="text-white" />
                    </div>
                    <h2 className="text-3xl font-bold mb-3 tracking-tight">Showcase Offline</h2>
                    <p className="text-gray-300 text-sm leading-relaxed mb-6">
                        {folderName ? `The folder "${folderName}" is empty or not available.` : 'We are currently updating our vehicle fleet showcase.'} <br />
                        Please check back shortly.
                    </p>
                    <div className="flex items-center gap-2 text-xs font-mono text-gray-400 bg-black/30 px-4 py-2 rounded-lg">
                        <Clock size={12} />
                        Updates in progress...
                    </div>
                </div>
            </div>
        );
    }

    return (
        <div 
            ref={containerRef}
            className="h-[100dvh] w-full overflow-y-scroll snap-y snap-mandatory bg-black scroll-smooth no-scrollbar touch-pan-y"
            onScroll={handleScroll}
        >
            {/* Top Bar */}
            <div className="fixed top-0 left-0 right-0 z-50 p-6 flex justify-between items-start pointer-events-none bg-gradient-to-b from-black/60 to-transparent">
                <div className="pointer-events-auto">
                    <h1 className="text-white font-bold text-lg drop-shadow-md tracking-wide">{title}</h1>
                    {isOfflineMode && (
                        <span className="flex items-center gap-1 text-[10px] text-amber-200 bg-amber-900/40 border border-amber-800 px-2 py-0.5 rounded backdrop-blur-sm w-fit mt-1">
                            <CloudOff size={10} />
                            Offline Mode (S3 Fallback)
                        </span>
                    )}
                </div>
                <button 
                    onClick={() => setIsMuted(!isMuted)}
                    className="pointer-events-auto bg-black/30 backdrop-blur-md p-3 rounded-full text-white hover:bg-black/50 transition-colors border border-white/10"
                >
                    {isMuted ? <VolumeX size={20} /> : <Volume2 size={20} />}
                </button>
            </div>

            {items.map((item, index) => (
                <div 
                    key={item.id} 
                    className="h-[100dvh] w-full snap-center relative flex items-center justify-center overflow-hidden"
                >
                    {/* 1. Dynamic Blurred Background */}
                    <div className="absolute inset-0 z-0 overflow-hidden">
                        {item.type === 'video' ? (
                            <video 
                                src={item.url} 
                                className="w-full h-full object-cover blur-3xl scale-125 opacity-60 brightness-75"
                                muted 
                                loop 
                                playsInline
                            />
                        ) : (
                            <img 
                                src={item.url} 
                                alt="bg" 
                                className="w-full h-full object-cover blur-3xl scale-125 opacity-60 brightness-75"
                            />
                        )}
                        <div className="absolute inset-0 bg-black/40" />
                    </div>

                    {/* 2. Main Content */}
                    <div className="relative z-10 w-full h-full flex items-center justify-center p-0 md:p-8">
                        {item.type === 'video' ? (
                            <div className="relative w-full h-full md:max-h-[85vh] md:w-auto md:max-w-md md:aspect-[9/16] flex items-center justify-center">
                                {index === activeIndex && (
                                    <VideoPlayer 
                                        src={item.url} 
                                        isActive={index === activeIndex} 
                                        isMuted={isMuted} 
                                    />
                                )}
                                {/* Loading Shimmer if not active yet */}
                                {index !== activeIndex && (
                                    <div className="w-full h-full bg-gray-800 animate-pulse rounded-none md:rounded-2xl" />
                                )}
                            </div>
                        ) : (
                            <img 
                                src={item.url} 
                                alt="content" 
                                className="w-full h-full md:h-auto md:max-h-[85vh] md:w-auto md:max-w-full object-contain md:rounded-2xl shadow-2xl z-10 bg-black"
                                loading="lazy"
                            />
                        )}
                    </div>
                </div>
            ))}

            {/* Bottom Floating Action Buttons */}
            <div className="fixed bottom-8 right-6 z-50 flex flex-col gap-4">
                <button 
                    className="bg-white/10 backdrop-blur-md border border-white/20 p-4 rounded-full text-white shadow-lg hover:bg-white/20 transition-all active:scale-95 flex flex-col items-center justify-center gap-1 w-14 h-14"
                    onClick={() => {
                        if (navigator.share) {
                            navigator.share({
                                title: title,
                                url: window.location.href
                            });
                        } else {
                            // Fallback
                            navigator.clipboard.writeText(window.location.href);
                            alert("Link copied to clipboard!");
                        }
                    }}
                >
                    <Share2 size={20} />
                </button>
                
                <button 
                    onClick={handleWhatsAppReturn}
                    className="bg-green-500 p-4 rounded-full text-white shadow-lg shadow-green-500/30 hover:bg-green-600 transition-all active:scale-95 w-14 h-14 flex items-center justify-center animate-bounce-slow"
                >
                    <MessageCircle size={24} fill="currentColor" />
                </button>
            </div>
            
            {/* Back Arrow for non-app users */}
            <div className="fixed top-6 left-6 z-50 md:hidden">
                 <button onClick={handleWhatsAppReturn} className="text-white/80 p-2 rounded-full bg-black/20 backdrop-blur-md border border-white/10">
                     <ArrowLeft size={24} />
                 </button>
            </div>
        </div>
    );
};
