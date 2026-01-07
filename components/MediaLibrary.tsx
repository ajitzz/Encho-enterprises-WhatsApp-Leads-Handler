
import React, { useState, useEffect } from 'react';
import { Upload, File, Image as ImageIcon, Video, Copy, Check, Trash2, Cloud } from 'lucide-react';
import { liveApiService } from '../services/liveApiService';

export const MediaLibrary = () => {
    const [files, setFiles] = useState<any[]>([]);
    const [uploading, setUploading] = useState(false);
    const [copiedId, setCopiedId] = useState<string | null>(null);

    useEffect(() => {
        loadFiles();
    }, []);

    const loadFiles = async () => {
        try {
            const data = await liveApiService.getMediaLibrary();
            setFiles(data);
        } catch (e) {
            console.error("Failed to load media library");
        }
    };

    const handleUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
        if (!e.target.files || e.target.files.length === 0) return;
        const file = e.target.files[0];
        setUploading(true);

        try {
            await liveApiService.uploadMedia(file);
            await loadFiles(); // Refresh list
        } catch (e) {
            alert("Upload failed. Ensure AWS Keys are set in .env");
        } finally {
            setUploading(false);
        }
    };

    const copyToClipboard = (url: string) => {
        navigator.clipboard.writeText(url);
        setCopiedId(url);
        setTimeout(() => setCopiedId(null), 2000);
    };

    return (
        <div className="p-8 max-w-7xl mx-auto h-screen flex flex-col">
            <div className="flex items-center justify-between mb-8">
                <div>
                    <h1 className="text-2xl font-bold text-gray-900 flex items-center gap-2">
                        <Cloud className="text-blue-600" /> AWS S3 Media Library
                    </h1>
                    <p className="text-gray-500">Upload approved assets here. Only these files can be sent to customers.</p>
                </div>
                
                <div className="relative">
                    <input 
                        type="file" 
                        id="file-upload" 
                        className="hidden" 
                        onChange={handleUpload} 
                        accept="image/*,video/*,application/pdf"
                    />
                    <label 
                        htmlFor="file-upload"
                        className={`flex items-center gap-2 px-6 py-3 rounded-lg text-white font-bold cursor-pointer transition-all ${uploading ? 'bg-gray-400 cursor-not-allowed' : 'bg-blue-600 hover:bg-blue-700 shadow-lg hover:-translate-y-1'}`}
                    >
                        {uploading ? (
                            <>Uploading...</>
                        ) : (
                            <>
                                <Upload size={18} />
                                Upload Asset
                            </>
                        )}
                    </label>
                </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-3 lg:grid-cols-4 gap-6 overflow-y-auto pb-20">
                {files.map((file) => (
                    <div key={file.id} className="bg-white rounded-xl border border-gray-200 overflow-hidden shadow-sm hover:shadow-md transition-shadow group">
                        <div className="aspect-video bg-gray-100 relative flex items-center justify-center overflow-hidden">
                            {file.type === 'video' ? (
                                <video src={file.url} className="w-full h-full object-cover" muted />
                            ) : file.type === 'image' ? (
                                <img src={file.url} alt={file.filename} className="w-full h-full object-cover" />
                            ) : (
                                <File size={48} className="text-gray-400" />
                            )}
                            
                            <div className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center gap-2">
                                <a href={file.url} target="_blank" rel="noreferrer" className="bg-white text-black text-xs font-bold px-3 py-1.5 rounded-full hover:bg-gray-100">View</a>
                            </div>
                        </div>
                        
                        <div className="p-4">
                            <div className="flex items-center gap-2 mb-2">
                                {file.type === 'video' ? <Video size={14} className="text-purple-500" /> : <ImageIcon size={14} className="text-blue-500" />}
                                <span className="text-xs font-bold text-gray-500 uppercase">{file.type}</span>
                            </div>
                            <h3 className="text-sm font-medium text-gray-900 truncate mb-3" title={file.filename}>{file.filename}</h3>
                            
                            <button 
                                onClick={() => copyToClipboard(file.url)}
                                className={`w-full flex items-center justify-center gap-2 py-2 rounded-lg text-xs font-bold transition-colors border ${copiedId === file.url ? 'bg-green-50 border-green-200 text-green-700' : 'bg-gray-50 border-gray-200 text-gray-600 hover:bg-white'}`}
                            >
                                {copiedId === file.url ? (
                                    <><Check size={14} /> Copied URL</>
                                ) : (
                                    <><Copy size={14} /> Copy Link</>
                                )}
                            </button>
                        </div>
                    </div>
                ))}

                {files.length === 0 && (
                    <div className="col-span-full py-20 text-center text-gray-400 border-2 border-dashed border-gray-200 rounded-xl">
                        <Cloud size={48} className="mx-auto mb-4 opacity-20" />
                        <p>No media uploaded yet. Upload images or videos to start.</p>
                    </div>
                )}
            </div>
        </div>
    );
};
