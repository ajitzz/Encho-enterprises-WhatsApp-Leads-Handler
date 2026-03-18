
import React, { useState, useEffect } from 'react';
import { X, Cloud, Folder, Video, ArrowLeft, FileText, Image as ImageIcon, Headset, Upload, Loader2 } from 'lucide-react';
import { liveApiService } from '../services/liveApiService';

interface MediaSelectorModalProps {
    isOpen: boolean;
    onClose: () => void;
    onSelect: (url: string, type: 'image' | 'video' | 'document' | 'audio') => void;
    allowedType?: 'Image' | 'Video' | 'Document' | 'Audio' | 'All';
}

export const MediaSelectorModal: React.FC<MediaSelectorModalProps> = ({ isOpen, onClose, onSelect, allowedType = 'All' }) => {
    const [files, setFiles] = useState<any[]>([]);
    const [folders, setFolders] = useState<any[]>([]);
    const [currentPath, setCurrentPath] = useState('/');
    const [loading, setLoading] = useState(false);
    const [uploading, setUploading] = useState(false);

    useEffect(() => {
        if (isOpen) {
            loadMedia(currentPath);
        } else {
            setCurrentPath('/'); // Reset to root on close
        }
    }, [isOpen, currentPath]);

    const loadMedia = (path: string) => {
        setLoading(true);
        liveApiService.getMediaLibrary(path)
            .then(data => {
                setFolders(data.folders);
                let filtered = data.files;
                
                if (allowedType !== 'All') {
                    filtered = data.files.filter((f: any) => {
                        if (allowedType === 'Image') return f.type === 'image';
                        if (allowedType === 'Video') return f.type === 'video';
                        if (allowedType === 'Document') return f.type === 'document';
                        if (allowedType === 'Audio') return f.type === 'audio';
                        return true;
                    });
                }
                setFiles(filtered);
            })
            .catch(console.error)
            .finally(() => setLoading(false));
    };

    const handleFolderClick = (folderName: string) => {
        const newPath = currentPath === '/' ? `/${folderName}` : `${currentPath}/${folderName}`;
        setCurrentPath(newPath);
    };

    const handleBackClick = () => {
         if (currentPath === '/') return;
         const parts = currentPath.split('/').filter(Boolean);
         parts.pop();
         const newPath = parts.length === 0 ? '/' : `/${parts.join('/')}`;
         setCurrentPath(newPath);
    };

    const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (!file) return;

        setUploading(true);
        try {
            const result = await liveApiService.uploadMedia(file, currentPath);
            if (result.success) {
                loadMedia(currentPath);
            }
        } catch (error) {
            console.error('Upload failed:', error);
            alert('Upload failed. Please try again.');
        } finally {
            setUploading(false);
        }
    };

    if (!isOpen) return null;

    return (
        <div className="fixed inset-0 bg-black/50 z-[100] flex items-center justify-center p-4 backdrop-blur-sm">
            <div className="bg-white rounded-xl shadow-2xl w-full max-w-3xl h-[80vh] flex flex-col animate-in fade-in zoom-in-95">
                <div className="p-4 border-b border-gray-100 flex justify-between items-center bg-gray-50 rounded-t-xl">
                    <h3 className="font-bold text-gray-900 flex items-center gap-2">
                        <Cloud size={18} className="text-blue-600" /> 
                        Select {allowedType === 'All' ? 'File' : allowedType} from S3
                    </h3>
                    <div className="flex items-center gap-2">
                        <label className={`flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs font-bold cursor-pointer transition-all ${uploading ? 'bg-gray-100 text-gray-400' : 'bg-blue-600 text-white hover:bg-blue-700 shadow-sm'}`}>
                            {uploading ? <Loader2 size={14} className="animate-spin" /> : <Upload size={14} />}
                            {uploading ? 'Uploading...' : 'Upload New'}
                            <input type="file" className="hidden" onChange={handleFileUpload} disabled={uploading} />
                        </label>
                        <button onClick={onClose} className="p-1 hover:bg-gray-200 rounded-full transition-colors"><X size={20} className="text-gray-400 hover:text-gray-600" /></button>
                    </div>
                </div>
                
                <div className="bg-white px-4 py-2 border-b border-gray-100 text-xs text-gray-500 flex items-center gap-2">
                    <span className="font-bold text-gray-700">Path:</span> 
                    <span className="font-mono bg-gray-100 px-1 rounded">{currentPath}</span>
                </div>

                <div className="flex-1 overflow-y-auto p-4 bg-slate-50">
                    {loading ? (
                        <div className="flex justify-center p-10"><span className="animate-spin mr-2">⏳</span> Loading Library...</div>
                    ) : (
                        <>
                            {currentPath !== '/' && (
                                <button 
                                    onClick={handleBackClick} 
                                    className="flex items-center gap-2 text-sm text-gray-600 mb-4 hover:text-blue-600 font-medium px-2 py-1 rounded hover:bg-white"
                                >
                                    <ArrowLeft size={16} /> Back to parent
                                </button>
                            )}

                            {/* Folders */}
                            {folders.length > 0 && (
                                <div className="mb-6">
                                    <h4 className="text-[10px] font-bold text-gray-400 uppercase mb-2 tracking-wider">Folders</h4>
                                    <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-5 gap-3">
                                        {folders.map(folder => (
                                            <div 
                                                key={folder.id} 
                                                onClick={() => handleFolderClick(folder.name)}
                                                className="bg-white p-3 rounded-lg border border-gray-200 cursor-pointer hover:border-blue-400 hover:shadow-sm flex flex-col items-center gap-2 transition-all"
                                            >
                                                <Folder size={28} className="text-yellow-400 fill-yellow-100" />
                                                <span className="text-xs font-medium text-gray-700 truncate w-full text-center">{folder.name}</span>
                                            </div>
                                        ))}
                                    </div>
                                </div>
                            )}

                            {/* Files */}
                            <div>
                                <h4 className="text-[10px] font-bold text-gray-400 uppercase mb-2 tracking-wider">Files</h4>
                                {files.length === 0 ? (
                                    <div className="text-center py-12 text-gray-400 text-sm italic border-2 border-dashed border-gray-200 rounded-lg bg-gray-50/50">
                                        No matching files found in this folder.
                                    </div>
                                ) : (
                                    <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-4">
                                        {files.map((file) => (
                                            <div 
                                                key={file.id}
                                                onClick={() => onSelect(file.url, file.type)}
                                                className="bg-white rounded-lg border border-gray-200 p-2 cursor-pointer hover:border-blue-500 hover:ring-2 hover:ring-blue-200 transition-all group flex flex-col h-40"
                                            >
                                                <div className="flex-1 bg-gray-100 rounded overflow-hidden mb-2 relative flex items-center justify-center">
                                                    {file.type === 'image' ? (
                                                        <img src={file.url} className="w-full h-full object-cover" alt="prev" />
                                                    ) : file.type === 'video' ? (
                                                        <Video size={32} className="text-purple-400" />
                                                    ) : file.type === 'audio' ? (
                                                        <div className="flex flex-col items-center justify-center">
                                                            <Headset size={32} className="text-emerald-400" />
                                                            <span className="text-[9px] font-bold text-gray-400 uppercase mt-1">AUDIO</span>
                                                        </div>
                                                    ) : (
                                                        <div className="flex flex-col items-center justify-center">
                                                            <FileText size={32} className="text-orange-400" />
                                                            <span className="text-[9px] font-bold text-gray-400 uppercase mt-1">{file.filename.split('.').pop()}</span>
                                                        </div>
                                                    )}
                                                </div>
                                                <div className="text-xs font-medium text-gray-700 truncate px-1" title={file.filename}>{file.filename}</div>
                                                <div className="text-[9px] text-gray-400 px-1 capitalize">{file.type}</div>
                                            </div>
                                        ))}
                                    </div>
                                )}
                            </div>
                        </>
                    )}
                </div>
            </div>
        </div>
    );
};
