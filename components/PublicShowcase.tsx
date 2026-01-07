
import React, { useState, useEffect, useRef } from 'react';
import { liveApiService } from '../services/liveApiService';
import { Share2, Volume2, VolumeX, MessageCircle, ArrowLeft, Loader2, Store, Clock } from 'lucide-react';

interface ShowcaseItem {
    id: string;
    url: string;
    type: string;
    filename: string;
}

const VideoPlayer = ({ src, isActive, isMuted }: { src: string, isActive: boolean, isMuted: boolean }) => {
    const videoRef = useRef<HTMLVideoElement>(null);

    useEffect(() => {
        if (videoRef.current) {
            if (isActive) {
                videoRef.current.currentTime = 0;
                videoRef.current.play().catch(e => console.log("Autoplay prevented", e));
            } else {
                videoRef.current.pause();
            }
        }
    }, [isActive]);

    return (
        <video 
            ref={videoRef}
            src={src}
            className="h-full w-full object-contain rounded-2xl shadow-2xl z-10"
            loop
            muted={isMuted}
            playsInline
        />
    );
};

export const PublicShowcase = ({ folderName }: { folderName?: string }) => {
    const [items, setItems] = useState<ShowcaseItem[]>([]);
    const [title, setTitle] = useState('');
    const [loading, setLoading] = useState(true);
    const [activeIndex, setActiveIndex] = useState(0);
    const [isMuted, setIsMuted] = useState(true);
    const containerRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        const fetchShowcase = async () => {
            try {
                // Pass folderName to API to support specific folder links
                const data = await liveApiService.getPublicShowcase(folderName);
                setItems(data.items);
                setTitle(data.title);
            } catch (e) {
                console.error("Failed to load showcase");
            } finally {
                setLoading(false);
            }
        };
        fetchShowcase();
    }, [folderName]);

    const handleScroll = () => {
        if (!containerRef.current) return;
        const index = Math.round(containerRef.current.scrollTop / window.innerHeight);
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
            <div className="h-screen w-full bg-black flex items-center justify-center">
                <div className="animate-spin rounded-full h-12 w-12 border-t-2 border-b-2 border-white"></div>
            </div>
        );
    }

    if (items.length === 0) {
        return (
            <div className="h-screen w-full bg-neutral-900 text-white flex flex-col items-center justify-center p-8 text-center relative overflow-hidden">
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
            className="h-screen w-full overflow-y-scroll snap-y snap-mandatory bg-black scroll-smooth no-scrollbar"
            onScroll={handleScroll}
        >
            {/* Overlay UI Controls */}
            <div className="fixed top-0 left-0 right-0 z-50 p-6 flex justify-between items-start pointer-events-none">
                <div className="pointer-events-auto">
                    <h1 className="text-white font-bold text-lg drop-shadow-md">{title}</h1>
                </div>
                <button 
                    onClick={() => setIsMuted(!isMuted)}
                    className="pointer-events-auto bg-black/20 backdrop-blur-md p-3 rounded-full text-white hover:bg-black/40 transition-colors"
                >
                    {isMuted ? <VolumeX size={20} /> : <Volume2 size={20} />}
                </button>
            </div>

            {items.map((item, index) => (
                <div 
                    key={item.id} 
                    className="h-screen w-full snap-center relative flex items-center justify-center overflow-hidden"
                >
                    {/* 1. Dynamic Blurred Background */}
                    <div className="absolute inset-0 z-0 overflow-hidden">
                        {item.type === 'video' ? (
                            <video 
                                src={item.url} 
                                className="w-full h-full object-cover blur-3xl scale-125 opacity-60 brightness-75"
                                muted 
                                loop 
                                autoPlay 
                                playsInline
                            />
                        ) : (
                            <img 
                                src={item.url} 
                                alt="bg" 
                                className="w-full h-full object-cover blur-3xl scale-125 opacity-60 brightness-75"
                            />
                        )}
                        <div className="absolute inset-0 bg-black/20" />
                    </div>

                    {/* 2. Main Content */}
                    <div className="relative z-10 w-full h-full flex items-center justify-center p-4 md:p-8">
                        {item.type === 'video' ? (
                            <div className="relative max-h-[85vh] w-full max-w-md aspect-[9/16]">
                                {index === activeIndex && (
                                    <VideoPlayer 
                                        src={item.url} 
                                        isActive={index === activeIndex} 
                                        isMuted={isMuted} 
                                    />
                                )}
                                {/* Loading Shimmer if not active yet */}
                                {index !== activeIndex && (
                                    <div className="w-full h-full bg-gray-800 animate-pulse rounded-2xl" />
                                )}
                            </div>
                        ) : (
                            <img 
                                src={item.url} 
                                alt="content" 
                                className="max-h-[85vh] w-auto max-w-full rounded-2xl shadow-2xl object-contain z-10"
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
                            alert("Share URL copied!");
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
                 <button onClick={handleWhatsAppReturn} className="text-white/80 p-2 rounded-full bg-black/20 backdrop-blur-md">
                     <ArrowLeft size={24} />
                 </button>
            </div>
        </div>
    );
};
