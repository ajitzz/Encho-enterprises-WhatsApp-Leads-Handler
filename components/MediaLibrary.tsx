
import React, { useState, useEffect } from 'react';
import { Upload, File, Image as ImageIcon, Video, Copy, Check, Trash2, Cloud, Folder, FolderPlus, Home, ChevronRight, X, Loader2, AlertCircle, RefreshCw, Zap, Globe, Eye, Link as LinkIcon, ExternalLink, Share2, Power } from 'lucide-react';
import { liveApiService } from '../services/liveApiService';

interface MediaFile {
    id: string;
    url: string;
    filename: string;
    type: string;
    media_id?: string;
}

interface MediaFolder {
    id: string;
    name: string;
    parent_path: string;
    is_public_showcase: boolean;
}

interface ShowcaseStatus {
    active: boolean;
    folderName?: string;
    folderId?: string;
}

export const MediaLibrary = () => {
    const [files, setFiles] = useState<MediaFile[]>([]);
    const [folders, setFolders] = useState<MediaFolder[]>([]);
    const [uploadStatus, setUploadStatus] = useState<'idle' | 'uploading' | 'error'>('idle');
    const [uploadError, setUploadError] = useState('');
    const [isLoadingContent, setIsLoadingContent] = useState(false);
    const [copiedId, setCopiedId] = useState<string | null>(null);
    const [isDeleting, setIsDeleting] = useState<string | null>(null);
    const [isSyncing, setIsSyncing] = useState<string | null>(null);
    const [isCreatingFolder, setIsCreatingFolder] = useState(false);
    
    // Path State
    const [currentPath, setCurrentPath] = useState('/');
    
    // Create Folder State
    const [showCreateFolder, setShowCreateFolder] = useState(false);
    const [newFolderName, setNewFolderName] = useState('');

    // CORS Help Modal
    const [showCorsHelp, setShowCorsHelp] = useState(false);

    // Share Modal State
    const [shareUrl, setShareUrl] = useState<string | null>(null);
    
    // Global Status
    const [globalStatus, setGlobalStatus] = useState<ShowcaseStatus | null>(null);

    useEffect(() => {
        loadMedia(currentPath);
        checkGlobalStatus();
    }, [currentPath]);

    const checkGlobalStatus = async () => {
        try {
            const status = await liveApiService.getShowcaseStatus();
            setGlobalStatus(status);
        } catch(e) {}
    };

    const loadMedia = async (path: string) => {
        setIsLoadingContent(true);
        try {
            const data = await liveApiService.getMediaLibrary(path);
            setFiles(data.files);
            setFolders(data.folders);
        } catch (e) {
            console.error("Failed to load media library");
        } finally {
            setIsLoadingContent(false);
        }
    };

    const handleUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
        if (!e.target.files || e.target.files.length === 0) return;
        const file = e.target.files[0];
        
        const duplicate = files.find(f => f.filename === file.name);
        if (duplicate) {
            const proceed = window.confirm(`File "${file.name}" already exists in this folder. \n\nUploading it again will create a duplicate copy and consume transfer credits. \n\nDo you want to proceed anyway?`);
            if (!proceed) {
                e.target.value = '';
                return;
            }
        }
        
        setUploadStatus('uploading');
        setUploadError('');

        try {
            await liveApiService.uploadMedia(file, currentPath);
            setUploadStatus('idle');
            await loadMedia(currentPath); 
        } catch (e: any) {
            console.error("Upload Error:", e);
            setUploadStatus('error');
            const msg = e.message || "Failed to upload file";
            if (msg.includes('409') || msg.includes('already exists')) {
                 setUploadError("File already exists (Backend Check).");
            } else if (msg.includes('Failed to fetch') || msg.includes('NetworkError') || msg.includes('CORS')) {
                 setUploadError("AWS CORS Error: Bucket permissions missing");
                 setShowCorsHelp(true);
            } else {
                 setUploadError(msg);
            }
        }
    };

    const handleSyncToWhatsApp = async (id: string) => {
        setIsSyncing(id);
        try {
            await liveApiService.syncFileToWhatsApp(id);
            await loadMedia(currentPath);
        } catch (e) {
            alert("Failed to sync media to WhatsApp. Check console.");
        } finally {
            setIsSyncing(null);
        }
    };

    const handleTogglePublic = async (folder: MediaFolder) => {
        if (folder.is_public_showcase) {
            // Toggle OFF
            const confirm = window.confirm(`Stop showcasing "${folder.name}"?`);
            if (!confirm) return;
            try {
                await liveApiService.unsetPublicFolder(folder.id);
                await loadMedia(currentPath);
                checkGlobalStatus();
            } catch(e) { alert("Failed to stop showcase"); }
        } else {
            // Toggle ON
            const confirm = window.confirm(`Set "${folder.name}" as Public Showcase?`);
            if (!confirm) return;
            try {
                await liveApiService.setPublicFolder(folder.id);
                await loadMedia(currentPath);
                checkGlobalStatus();
                setShareUrl(`${window.location.origin}/showcase`); // Auto-open share
            } catch(e) { alert("Failed to start showcase"); }
        }
    };
    
    const handleGlobalShutdown = async () => {
        if (!globalStatus?.folderId) return;
        const confirm = window.confirm("Are you sure you want to shut down the public showcase page? It will go offline immediately.");
        if (!confirm) return;
        
        try {
            await liveApiService.unsetPublicFolder(globalStatus.folderId);
            await loadMedia(currentPath); // Refresh view
            await checkGlobalStatus(); // Update banner
        } catch(e) {
            alert("Failed to shut down.");
        }
    };

    const handleOpenShare = (e: React.MouseEvent) => {
        e.stopPropagation();
        setShareUrl(`${window.location.origin}/showcase`);
    };

    const handleCreateFolder = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!newFolderName.trim() || isCreatingFolder) return;

        setIsCreatingFolder(true);
        try {
            await liveApiService.createFolder(newFolderName.trim(), currentPath);
            setNewFolderName('');
            setShowCreateFolder(false);
            await loadMedia(currentPath);
        } catch (e) {
            alert("Failed to create folder");
        } finally {
            setIsCreatingFolder(false);
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

    const navigateTo = (path: string) => {
        if (isLoadingContent) return; 
        setCurrentPath(path);
    };

    const enterFolder = (folderName: string) => {
        if (isLoadingContent) return;
        const newPath = currentPath === '/' ? `/${folderName}` : `${currentPath}/${folderName}`;
        setCurrentPath(newPath);
    };

    const renderBreadcrumbs = () => {
        const parts = currentPath.split('/').filter(Boolean);
        return (
            <div className="flex items-center gap-2 text-sm text-gray-600 bg-gray-50 px-4 py-2 rounded-lg border border-gray-200">
                <button 
                    onClick={() => navigateTo('/')}
                    disabled={isLoadingContent}
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
                                disabled={isLoadingContent}
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

    const renderSkeletons = () => (
        <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-5 gap-6 animate-pulse">
            {[1, 2, 3].map(i => (
                <div key={i} className="bg-gray-100 rounded-xl h-36 border border-gray-200"></div>
            ))}
        </div>
    );

    return (
        <div className="flex flex-col h-screen overflow-hidden">
            {/* GLOBAL SHOWCASE STATUS BANNER */}
            {globalStatus?.active && (
                <div className="bg-green-600 text-white px-8 py-3 flex items-center justify-between shadow-md shrink-0 z-20">
                    <div className="flex items-center gap-3">
                        <div className="bg-white/20 p-1.5 rounded-full animate-pulse">
                            <Globe size={18} />
                        </div>
                        <div>
                            <span className="font-bold text-sm">Public Showcase Active</span>
                            <div className="text-xs text-green-100 flex items-center gap-1">
                                Serving folder: <span className="font-mono bg-black/20 px-1 rounded">{globalStatus.folderName}</span>
                            </div>
                        </div>
                    </div>
                    <div className="flex items-center gap-3">
                        <button 
                            onClick={handleOpenShare}
                            className="text-xs font-bold bg-white/10 hover:bg-white/20 px-3 py-1.5 rounded-lg transition-colors flex items-center gap-2"
                        >
                            <ExternalLink size={14} /> View Page
                        </button>
                        <button 
                            onClick={handleGlobalShutdown}
                            className="text-xs font-bold bg-white text-red-600 px-3 py-1.5 rounded-lg hover:bg-red-50 transition-colors flex items-center gap-2 shadow-sm"
                        >
                            <Power size={14} /> Turn Off Showcase
                        </button>
                    </div>
                </div>
            )}

            <div className="p-8 max-w-7xl mx-auto flex-1 flex flex-col w-full overflow-hidden">
                <div className="flex items-center justify-between mb-6 shrink-0">
                    <div>
                        <h1 className="text-2xl font-bold text-gray-900 flex items-center gap-2">
                            <Cloud className="text-blue-600" /> AWS S3 Media Library
                        </h1>
                        <p className="text-gray-500 text-sm mt-1">Organize and upload approved assets. Sync to WhatsApp or Public Showcase.</p>
                    </div>
                    
                    <div className="flex gap-3 items-center">
                        {uploadStatus === 'error' && (
                            <div className="flex items-center gap-2">
                                <div className="text-xs text-red-600 font-bold bg-red-50 px-3 py-2 rounded-lg border border-red-100 flex items-center gap-2 animate-in fade-in slide-in-from-top-2">
                                    <AlertCircle size={14} />
                                    {uploadError}
                                </div>
                                <button onClick={() => setShowCorsHelp(true)} className="bg-red-600 text-white text-xs font-bold px-3 py-2 rounded-lg hover:bg-red-700 shadow-sm">Fix Config</button>
                            </div>
                        )}

                        <button 
                            onClick={() => setShowCreateFolder(true)}
                            className="flex items-center gap-2 px-4 py-3 rounded-lg text-gray-700 bg-white border border-gray-300 font-bold hover:bg-gray-50 transition-all shadow-sm disabled:opacity-50"
                            disabled={uploadStatus === 'uploading' || isCreatingFolder}
                        >
                            <FolderPlus size={18} /> New Folder
                        </button>

                        <div className="relative">
                            <input 
                                type="file" 
                                id="file-upload" 
                                className="hidden" 
                                onChange={handleUpload} 
                                accept="image/*,video/*,application/pdf"
                                disabled={uploadStatus === 'uploading'}
                            />
                            <label 
                                htmlFor="file-upload"
                                className={`flex items-center gap-2 px-6 py-3 rounded-lg text-white font-bold cursor-pointer transition-all ${uploadStatus === 'uploading' ? 'bg-blue-800 cursor-not-allowed' : 'bg-blue-600 hover:bg-blue-700 shadow-lg hover:-translate-y-1'}`}
                            >
                                {uploadStatus === 'uploading' ? <><Loader2 size={18} className="animate-spin" /> Uploading...</> : <><Upload size={18} /> Upload Asset</>}
                            </label>
                        </div>
                    </div>
                </div>

                <div className="mb-6 shrink-0">{renderBreadcrumbs()}</div>

                <div className="flex-1 overflow-y-auto pb-20">
                    {isLoadingContent ? renderSkeletons() : (
                        <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-5 gap-6">
                            {/* Folders */}
                            {folders.map(folder => (
                                <div 
                                    key={folder.id} 
                                    className={`bg-white rounded-xl border p-4 shadow-sm hover:shadow-md transition-all cursor-pointer group flex flex-col items-center justify-between h-40 relative select-none ${folder.is_public_showcase ? 'border-green-400 ring-2 ring-green-100' : 'border-gray-200 hover:border-blue-300'}`}
                                    onClick={() => enterFolder(folder.name)}
                                >
                                    {folder.is_public_showcase && (
                                        <div className="absolute top-2 left-2 bg-green-500 text-white text-[10px] font-bold px-2 py-0.5 rounded-full flex items-center gap-1 shadow-sm z-10">
                                            <Eye size={10} /> Public
                                        </div>
                                    )}
                                    
                                    <div className="flex-1 flex flex-col items-center justify-center w-full mt-4">
                                        <Folder size={40} className="text-yellow-400 fill-yellow-100 group-hover:scale-110 transition-transform duration-200" />
                                        <span className="mt-2 text-sm font-semibold text-gray-700 group-hover:text-blue-600 truncate max-w-full px-2">{folder.name}</span>
                                    </div>
                                    
                                    <div className="w-full flex justify-between mt-1 pt-2 border-t border-gray-100">
                                        <div className="flex items-center gap-2">
                                            <button
                                                onClick={(e) => { e.stopPropagation(); handleTogglePublic(folder); }}
                                                className={`p-1.5 rounded-full transition-colors flex items-center gap-1 ${folder.is_public_showcase ? 'text-green-600 bg-green-50 hover:bg-green-100' : 'text-gray-300 hover:text-green-600 hover:bg-green-50'}`}
                                                title={folder.is_public_showcase ? "Stop Showcase (Turn Off)" : "Set as Public Showcase"}
                                            >
                                                <Globe size={14} />
                                            </button>
                                            
                                            {/* Separate Share Button: Only visible if active */}
                                            {folder.is_public_showcase && (
                                                <button
                                                    onClick={handleOpenShare}
                                                    className="p-1.5 rounded-full transition-colors text-blue-500 bg-blue-50 hover:bg-blue-100"
                                                    title="Get Share Link"
                                                >
                                                    <Share2 size={14} />
                                                </button>
                                            )}
                                        </div>

                                        <button
                                            onClick={(e) => { e.stopPropagation(); handleDeleteFolder(folder.id, folder.name); }}
                                            className="p-1.5 text-gray-300 hover:text-red-500 hover:bg-red-50 rounded-full transition-colors"
                                        >
                                            {isDeleting === folder.id ? <Loader2 size={14} className="animate-spin text-red-500" /> : <Trash2 size={14} />}
                                        </button>
                                    </div>
                                </div>
                            ))}

                            {/* Files */}
                            {files.map((file) => (
                                <div key={file.id} className="bg-white rounded-xl border border-gray-200 overflow-hidden shadow-sm hover:shadow-md transition-shadow group flex flex-col relative select-none">
                                    <div className="aspect-video bg-gray-100 relative flex items-center justify-center overflow-hidden">
                                        {file.type === 'video' ? (
                                            <video src={file.url} className="w-full h-full object-cover" muted />
                                        ) : file.type === 'image' ? (
                                            <img src={file.url} alt={file.filename} className="w-full h-full object-cover" />
                                        ) : (
                                            <div className="flex flex-col items-center justify-center h-full text-gray-400"><File size={32} /></div>
                                        )}
                                        <button 
                                            onClick={() => handleDeleteFile(file.id, file.filename)}
                                            className="absolute top-2 right-2 bg-white/90 text-red-500 p-1.5 rounded-full hover:bg-red-500 hover:text-white transition-colors opacity-0 group-hover:opacity-100 z-10 shadow-sm"
                                        >
                                            <Trash2 size={14} />
                                        </button>
                                    </div>
                                    
                                    <div className="p-3 flex-1 flex flex-col">
                                        <div className="flex items-center justify-between mb-1">
                                            <div className="flex items-center gap-1">
                                                {file.type === 'video' ? <Video size={12} className="text-purple-500" /> : <ImageIcon size={12} className="text-blue-500" />}
                                                <span className="text-[10px] font-bold text-gray-500 uppercase">{file.type}</span>
                                            </div>
                                            {file.media_id ? (
                                                <span className="text-[10px] bg-green-100 text-green-700 px-1.5 rounded flex items-center gap-1" title="Synced to WhatsApp">
                                                    <Zap size={10} fill="currentColor" /> Synced
                                                </span>
                                            ) : (
                                                <button 
                                                    onClick={(e) => { e.stopPropagation(); handleSyncToWhatsApp(file.id); }}
                                                    className="text-[10px] bg-gray-100 text-gray-500 px-1.5 rounded hover:bg-blue-100 hover:text-blue-700 flex items-center gap-1 transition-colors"
                                                    disabled={isSyncing === file.id}
                                                >
                                                    {isSyncing === file.id ? <Loader2 size={10} className="animate-spin" /> : <RefreshCw size={10} />}
                                                    Sync
                                                </button>
                                            )}
                                        </div>
                                        <h3 className="text-xs font-medium text-gray-900 truncate mb-3" title={file.filename}>{file.filename}</h3>
                                        
                                        <button 
                                            onClick={(e) => { e.stopPropagation(); copyToClipboard(file.url); }}
                                            className={`mt-auto w-full flex items-center justify-center gap-2 py-1.5 rounded-lg text-xs font-bold transition-colors border ${copiedId === file.url ? 'bg-green-50 border-green-200 text-green-700' : 'bg-gray-50 border-gray-200 text-gray-600 hover:bg-white'}`}
                                        >
                                            {copiedId === file.url ? <><Check size={12} /> Copied</> : <><Copy size={12} /> Copy Link</>}
                                        </button>
                                    </div>
                                </div>
                            ))}
                        </div>
                    )}
                </div>
                
                {showCreateFolder && (
                    <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4 backdrop-blur-sm">
                        <div className="bg-white rounded-xl shadow-2xl w-full max-w-sm overflow-hidden animate-in fade-in zoom-in-95">
                            <div className="p-4 border-b border-gray-100 flex justify-between items-center">
                                <h3 className="font-bold text-gray-900 flex items-center gap-2"><FolderPlus size={18} className="text-blue-600" /> Create New Folder</h3>
                                <button onClick={() => setShowCreateFolder(false)}><X size={20} className="text-gray-400" /></button>
                            </div>
                            <form onSubmit={handleCreateFolder} className="p-6">
                                <label className="block text-xs font-bold text-gray-500 uppercase mb-2">Folder Name</label>
                                <input type="text" autoFocus value={newFolderName} onChange={(e) => setNewFolderName(e.target.value)} placeholder="e.g. Marketing" className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-blue-500 outline-none mb-4" />
                                <div className="flex gap-3">
                                    <button type="button" onClick={() => setShowCreateFolder(false)} className="flex-1 py-2 border border-gray-300 rounded-lg text-sm font-medium hover:bg-gray-50">Cancel</button>
                                    <button type="submit" disabled={!newFolderName.trim() || isCreatingFolder} className="flex-1 py-2 bg-blue-600 text-white rounded-lg text-sm font-bold hover:bg-blue-700 disabled:opacity-50 flex items-center justify-center gap-2">{isCreatingFolder ? <Loader2 size={14} className="animate-spin" /> : 'Create'}</button>
                                </div>
                            </form>
                        </div>
                    </div>
                )}

                {shareUrl && (
                    <div className="fixed inset-0 bg-black/50 z-[100] flex items-center justify-center p-4 backdrop-blur-sm">
                        <div className="bg-white rounded-xl shadow-2xl w-full max-w-md overflow-hidden animate-in fade-in zoom-in-95">
                            <div className="p-4 border-b border-gray-100 flex justify-between items-center bg-gray-50">
                                <h3 className="font-bold text-gray-900 flex items-center gap-2"><Globe size={18} className="text-green-600" /> Public Showcase Link</h3>
                                <button onClick={() => setShareUrl(null)}><X size={20} className="text-gray-400" /></button>
                            </div>
                            <div className="p-6">
                                <p className="text-sm text-gray-600 mb-4">Share this link with customers to showcase the contents of this folder in an immersive viewer.</p>
                                
                                <div className="flex items-center gap-2 p-2 bg-gray-100 rounded-lg border border-gray-200 mb-4">
                                    <LinkIcon size={16} className="text-gray-400 flex-shrink-0" />
                                    <input 
                                        type="text" 
                                        readOnly 
                                        value={shareUrl} 
                                        className="bg-transparent border-none text-sm text-gray-800 flex-1 outline-none truncate font-mono"
                                    />
                                    <button 
                                        onClick={() => copyToClipboard(shareUrl)} 
                                        className={`p-2 rounded-md transition-colors ${copiedId === shareUrl ? 'bg-green-100 text-green-700' : 'bg-white shadow-sm hover:bg-gray-50 text-gray-600'}`}
                                    >
                                        {copiedId === shareUrl ? <Check size={16} /> : <Copy size={16} />}
                                    </button>
                                </div>

                                <a 
                                    href={shareUrl} 
                                    target="_blank" 
                                    rel="noreferrer"
                                    className="w-full bg-blue-600 hover:bg-blue-700 text-white font-bold py-2.5 rounded-lg flex items-center justify-center gap-2 transition-colors"
                                >
                                    <ExternalLink size={16} /> Open Page
                                </a>
                            </div>
                        </div>
                    </div>
                )}
                
                {showCorsHelp && (
                    <div className="fixed inset-0 bg-black/50 z-[100] flex items-center justify-center p-4 backdrop-blur-sm">
                        <div className="bg-white rounded-xl shadow-2xl w-full max-w-2xl overflow-hidden animate-in fade-in zoom-in-95 flex flex-col max-h-[90vh]">
                            <div className="p-4 border-b border-gray-100 flex justify-between items-center bg-gray-50">
                                <h3 className="font-bold text-red-600 flex items-center gap-2"><AlertCircle size={20} /> AWS S3 CORS Configuration Required</h3>
                                <button onClick={() => setShowCorsHelp(false)}><X size={20} className="text-gray-400" /></button>
                            </div>
                            <div className="p-6 overflow-y-auto">
                                <p className="text-sm text-gray-600 mb-4">Your browser blocked the upload because the S3 Bucket does not allow cross-origin requests. <br /><strong>Paste this JSON into your AWS S3 Permissions &gt; CORS.</strong></p>
                                <div className="bg-gray-900 text-gray-100 p-4 rounded-lg font-mono text-xs relative overflow-auto">
<pre>{`[
    {
        "AllowedHeaders": ["*"],
        "AllowedMethods": ["PUT", "POST", "DELETE", "GET"],
        "AllowedOrigins": ["*"],
        "ExposeHeaders": []
    }
]`}</pre>
                                </div>
                            </div>
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
};
