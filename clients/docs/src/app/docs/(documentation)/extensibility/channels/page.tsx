import { ExtensibilityChannelsContent } from "@/app/docs/_components/extensibility-channels-content";
import { createMetadata } from "@/lib/metadata";

export const metadata = createMetadata({
  title: "Channels - Vellum Docs",
  description:
    "Expose plugin handlers to external callers by declaring public or private ingress in channels/ingress.json. The gateway applies the selected access boundary and forwards accepted requests.",
  path: "/docs/extensibility/channels",
});

export default function ExtensibilityChannelsPage() {
  return <ExtensibilityChannelsContent />;
}
