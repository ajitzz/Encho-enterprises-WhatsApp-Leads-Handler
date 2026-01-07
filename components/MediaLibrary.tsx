
import React, { useState, useEffect } from 'react';
import { Upload, File, Image as ImageIcon, Video, Copy, Check, Trash2, Cloud, Folder, FolderPlus, Home, ChevronRight, X } from 'lucide-react';
import { liveApiService } from '../services/liveApiService';

interface MediaFile {
    id: string;
    url: string;
    filename: string;
    type: string;
}

interface MediaFolder {
    id: string;
    name: string;
    parent_path: string;
}

export const MediaLibrary = () => {
    const [files, setFiles] = useState<MediaFile[]>([]);
    const [folders, setFolders] = useState<MediaFolder[]>([]);
    const [uploading, setUploading] = useState(false);
    const [copiedId, setCopiedId] = useState<string | null>(null);
    const [isDeleting, setIsDeleting] = useState<string | null>(null);
    
    // Path State
    const [currentPath, setCurrentPath] = useState('/');
    
    // Create Folder State
    const [showCreateFolder, setShowCreateFolder] = useState(false);
    const [newFolderName, setNewFolderName] = useState('');

    useEffect(() => {
        loadMedia(currentPath);
    }, [currentPath]);

    const loadMedia = async (path: string) => {
        try {
            const data = await liveApiService.getMediaLibrary(path);
            setFiles(data.files);
            setFolders(data.folders);
        } catch (e) {
            console.error("Failed to load media library");
        }
    };

    const handleUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
        if (!e.target.files || e.target.files.length === 0) return;
        const file = e.target.files[0];
        setUploading(true);

        try {
            await liveApiService.uploadMedia(file, currentPath);
            await loadMedia(currentPath); // Refresh
        } catch (e) {
            alert("Upload failed. Ensure AWS Keys are set in .env");
        } finally {
            setUploading(false);
        }
    };

    const handleCreateFolder = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!newFolderName.trim()) return;

        try {
            await liveApiService.createFolder(newFolderName.trim(), currentPath);
            setNewFolderName('');
            setShowCreateFolder(false);
            await loadMedia(currentPath);
        } catch (e) {
            alert("Failed to create folder");
        }
    };

    const handleDeleteFile = async (id: string, filename: string) => {
        if (!window.confirm(`Are you sure you want to delete ${filename}? This cannot be undone.`)) return;
        
        setIsDeleting(id);
        try {
            await liveApiService.deleteMediaFile(id);
            await loadMedia(currentPath);
        } catch (e) {
            alert("Failed to delete file");
        } finally {
            setIsDeleting(null);
        }
    };

    const handleDeleteFolder = async (id: string, name: string) => {
        if (!window.confirm(`Delete folder "${name}"? Only empty folders can be deleted.`)) return;
        
        setIsDeleting(id);
        try {
            await liveApiService.deleteFolder(id);
            await loadMedia(currentPath);
        } catch (e) {
            alert("Failed to delete folder. Please ensure it is empty.");
        } finally {
            setIsDeleting(null);
        }
    };

    const copyToClipboard = (url: string) => {
        navigator.clipboard.writeText(url);
        setCopiedId(url);
        setTimeout(() => setCopiedId(null), 2000);
    };

    // Breadcrumb Navigation Logic
    const navigateTo = (path: string) => {
        setCurrentPath(path);
    };

    const navigateUp = () => {
        if (currentPath === '/') return;
        const parts = currentPath.split('/').filter(Boolean);
        parts.pop();
        const parent = parts.length === 0 ? '/' : '/' + parts.join('/');
        setCurrentPath(parent);
    };

    const enterFolder = (folderName: string) => {
        const newPath = currentPath === '/' ? `/${folderName}` : `${currentPath}/${folderName}`;
        setCurrentPath(newPath);
    };

    // Render Breadcrumbs
    const renderBreadcrumbs = () => {
        const parts = currentPath.split('/').filter(Boolean);
        return (
            <div className="flex items-center gap-2 text-sm text-gray-600 bg-gray-50 px-4 py-2 rounded-lg border border-gray-200">
                <button 
                    onClick={() => navigateTo('/')}
                    className={`flex items-center hover:text-blue-600 transition-colors ${currentPath === '/' ? 'font-bold text-gray-900' : ''}`}
                >
                    <Home size={16} />
                </button>
                {parts.map((part, index) => {
                    const path = '/' + parts.slice(0, index + 1).join('/');
                    return (
                        <React.Fragment key={index}>
                            <ChevronRight size={14} className="text-gray-400" />
                            <button 
                                onClick={() => navigateTo(path)}
                                className={`hover:text-blue-600 transition-colors ${index === parts.length - 1 ? 'font-bold text-gray-900' : ''}`}
                            >
                                {part}
                            </button>
                        </React.Fragment>
                    );
                })}
            </div>
        );
    };

    return (
        <div className="p-8 max-w-7xl mx-auto h-screen flex flex-col">
            {/* Header */}
            <div className="flex items-center justify-between mb-6">
                <div>
                    <h1 className="text-2xl font-bold text-gray-900 flex items-center gap-2">
                        <Cloud className="text-blue-600" /> AWS S3 Media Library
                    </h1>
                    <p className="text-gray-500 text-sm mt-1">Organize and upload approved assets for use in chat.</p>
                </div>
                
                <div className="flex gap-3">
                     <button 
                        onClick={() => setShowCreateFolder(true)}
                        className="flex items-center gap-2 px-4 py-3 rounded-lg text-gray-700 bg-white border border-gray-300 font-bold hover:bg-gray-50 transition-all shadow-sm"
                    >
                        <FolderPlus size={18} />
                        New Folder
                    </button>

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
            </div>

            {/* Navigation Bar */}
            <div className="mb-6">
                {renderBreadcrumbs()}
            </div>

            {/* Grid Content */}
            <div className="flex-1 overflow-y-auto pb-20">
                <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-5 gap-6">
                    
                    {/* Folders */}
                    {folders.map(folder => (
                        <div 
                            key={folder.id} 
                            className="bg-white rounded-xl border border-gray-200 p-4 shadow-sm hover:shadow-md hover:border-blue-300 transition-all cursor-pointer group flex flex-col items-center justify-between h-36 relative"
                            onClick={() => enterFolder(folder.name)}
                        >
                            <div className="flex-1 flex flex-col items-center justify-center w-full">
                                <Folder size={40} className="text-yellow-400 fill-yellow-100 group-hover:scale-110 transition-transform duration-200" />
                                <span className="mt-2 text-sm font-semibold text-gray-700 group-hover:text-blue-600 truncate max-w-full px-2">{folder.name}</span>
                            </div>
                            
                            <button
                                onClick={(e) => {
                                    e.stopPropagation();
                                    handleDeleteFolder(folder.id, folder.name);
                                }}
                                className="absolute top-2 right-2 p-1.5 text-gray-300 hover:text-red-500 hover:bg-red-50 rounded-full opacity-0 group-hover:opacity-100 transition-opacity"
                                title="Delete Folder"
                            >
                                <Trash2 size={14} />
                            </button>
                        </div>
                    ))}

                    {/* Files */}
                    {files.map((file) => (
                        <div key={file.id} className="bg-white rounded-xl border border-gray-200 overflow-hidden shadow-sm hover:shadow-md transition-shadow group flex flex-col relative">
                            {isDeleting === file.id && (
                                <div className="absolute inset-0 bg-white/80 z-20 flex items-center justify-center">
                                    <div className="w-6 h-6 border-2 border-red-500 border-t-transparent rounded-full animate-spin"></div>
                                </div>
                            )}

                            <div className="aspect-video bg-gray-100 relative flex items-center justify-center overflow-hidden">
                                {file.type === 'video' ? (
                                    <video src={file.url} className="w-full h-full object-cover" muted />
                                ) : file.type === 'image' ? (
                                    <img src={file.url} alt={file.filename} className="w-full h-full object-cover" />
                                ) : (
                                    <File size={32} className="text-gray-400" />
                                )}
                                
                                <div className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center gap-2">
                                    <a href={file.url} target="_blank" rel="noreferrer" className="bg-white text-black text-xs font-bold px-3 py-1.5 rounded-full hover:bg-gray-100">View</a>
                                </div>

                                <button 
                                    onClick={() => handleDeleteFile(file.id, file.filename)}
                                    className="absolute top-2 right-2 bg-white/90 text-red-500 p-1.5 rounded-full hover:bg-red-500 hover:text-white transition-colors opacity-0 group-hover:opacity-100 z-10 shadow-sm"
                                    title="Delete File"
                                >
                                    <Trash2 size={14} />
                                </button>
                            </div>
                            
                            <div className="p-3 flex-1 flex flex-col">
                                <div className="flex items-center gap-2 mb-1">
                                    {file.type === 'video' ? <Video size={12} className="text-purple-500" /> : <ImageIcon size={12} className="text-blue-500" />}
                                    <span className="text-[10px] font-bold text-gray-500 uppercase">{file.type}</span>
                                </div>
                                <h3 className="text-xs font-medium text-gray-900 truncate mb-3" title={file.filename}>{file.filename}</h3>
                                
                                <button 
                                    onClick={(e) => { e.stopPropagation(); copyToClipboard(file.url); }}
                                    className={`mt-auto w-full flex items-center justify-center gap-2 py-1.5 rounded-lg text-xs font-bold transition-colors border ${copiedId === file.url ? 'bg-green-50 border-green-200 text-green-700' : 'bg-gray-50 border-gray-200 text-gray-600 hover:bg-white'}`}
                                >
                                    {copiedId === file.url ? (
                                        <><Check size={12} /> Copied</>
                                    ) : (
                                        <><Copy size={12} /> Copy Link</>
                                    )}
                                </button>
                            </div>
                        </div>
                    ))}
                </div>

                {folders.length === 0 && files.length === 0 && (
                    <div className="py-20 text-center text-gray-400 border-2 border-dashed border-gray-200 rounded-xl bg-gray-50/50">
                        <div className="mx-auto w-16 h-16 bg-gray-100 rounded-full flex items-center justify-center mb-4">
                            <Cloud size={32} className="opacity-40" />
                        </div>
                        <p className="font-medium">This folder is empty.</p>
                        <p className="text-sm mt-1">Upload files or create a subfolder to get started.</p>
                    </div>
                )}
            </div>

            {/* Create Folder Modal */}
            {showCreateFolder && (
                <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4 backdrop-blur-sm">
                    <div className="bg-white rounded-xl shadow-2xl w-full max-w-sm overflow-hidden animate-in fade-in zoom-in-95">
                        <div className="p-4 border-b border-gray-100 flex justify-between items-center">
                            <h3 className="font-bold text-gray-900 flex items-center gap-2">
                                <FolderPlus size={18} className="text-blue-600" />
                                Create New Folder
                            </h3>
                            <button onClick={() => setShowCreateFolder(false)}><X size={20} className="text-gray-400" /></button>
                        </div>
                        <form onSubmit={handleCreateFolder} className="p-6">
                            <label className="block text-xs font-bold text-gray-500 uppercase mb-2">Folder Name</label>
                            <input 
                                type="text"
                                autoFocus
                                value={newFolderName}
                                onChange={(e) => setNewFolderName(e.target.value)}
                                placeholder="e.g. Marketing"
                                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-blue-500 outline-none mb-4"
                            />
                            <div className="flex gap-3">
                                <button type="button" onClick={() => setShowCreateFolder(false)} className="flex-1 py-2 border border-gray-300 rounded-lg text-sm font-medium hover:bg-gray-50">Cancel</button>
                                <button type="submit" disabled={!newFolderName.trim()} className="flex-1 py-2 bg-blue-600 text-white rounded-lg text-sm font-bold hover:bg-blue-700 disabled:opacity-50">Create</button>
                            </div>
                        </form>
                    </div>
                </div>
            )}
        </div>
    );
};
