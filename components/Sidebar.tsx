import React from "react";
import { MessageSquare, Image, Video, Keyboard, Phone, List } from "lucide-react";

interface SidebarItem {
  label: string;
  type: "send" | "collect";
  subtype: string;
  icon: React.ReactNode;
  description: string;
}

interface SidebarProps {
  onDragStart: (event: React.DragEvent<HTMLDivElement>, node: SidebarItem) => void;
}

const sendItems: SidebarItem[] = [
  {
    label: "Text Message",
    type: "send",
    subtype: "Text",
    icon: <MessageSquare className="h-4 w-4" />,
    description: "Send a simple text message",
  },
  {
    label: "Image Message",
    type: "send",
    subtype: "Image",
    icon: <Image className="h-4 w-4" />,
    description: "Share an image with the user",
  },
  {
    label: "Video Message",
    type: "send",
    subtype: "Video",
    icon: <Video className="h-4 w-4" />,
    description: "Send a video clip",
  },
];

const collectItems: SidebarItem[] = [
  {
    label: "Ask Text Response",
    type: "collect",
    subtype: "Text",
    icon: <Keyboard className="h-4 w-4" />,
    description: "Collect a text reply",
  },
  {
    label: "Ask Phone Number",
    type: "collect",
    subtype: "Phone",
    icon: <Phone className="h-4 w-4" />,
    description: "Capture the user's phone",
  },
  {
    label: "Button List",
    type: "collect",
    subtype: "Button List",
    icon: <List className="h-4 w-4" />,
    description: "Present quick reply buttons",
  },
];

const Sidebar: React.FC<SidebarProps> = ({ onDragStart }) => {
  const renderItem = (item: SidebarItem) => (
    <div
      key={`${item.type}-${item.subtype}`}
      draggable
      onDragStart={(event) => onDragStart(event, item)}
      className="flex cursor-grab items-start gap-3 rounded-lg border border-slate-200 bg-white p-3 shadow-sm transition hover:shadow-md"
    >
      <div className="flex h-10 w-10 items-center justify-center rounded-md bg-slate-100 text-slate-700">
        {item.icon}
      </div>
      <div>
        <p className="font-medium text-slate-800">{item.label}</p>
        <p className="text-sm text-slate-500">{item.description}</p>
      </div>
    </div>
  );

  return (
    <aside className="sticky top-4 flex h-[calc(100vh-2rem)] w-80 flex-col gap-4 overflow-y-auto rounded-xl border border-slate-200 bg-white p-4 shadow-lg">
      <div>
        <h3 className="text-sm font-semibold uppercase tracking-wide text-slate-500">Send Message</h3>
        <div className="mt-3 flex flex-col gap-3">{sendItems.map(renderItem)}</div>
      </div>

      <div className="border-t border-slate-200 pt-4">
        <h3 className="text-sm font-semibold uppercase tracking-wide text-slate-500">Collect Input</h3>
        <div className="mt-3 flex flex-col gap-3">{collectItems.map(renderItem)}</div>
      </div>
    </aside>
  );
};

export type { SidebarItem };
export default Sidebar;
