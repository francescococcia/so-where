import { ChevronDown, MapPin } from "lucide-react";
import { AddVenueDialog } from "@/components/add-venue-dialog";
import { AskPanel } from "@/components/ask-panel";
import { AuthMenu } from "@/components/auth-menu";
import { Button } from "@/components/ui/button";
import { VenueHome } from "@/components/venue-home";

export default function Home() {
  return (
    <main className="min-h-screen bg-[#fafaf7] text-[#20202a]">
      <header className="flex h-16 items-center justify-between border-b border-[#ecebf0] bg-white px-6 sm:px-10">
        <div className="flex items-center gap-10">
          <a href="/" className="flex items-center gap-2 text-[21px] font-semibold tracking-[-0.04em]" aria-label="Lumap home">
            <MapPin className="h-8 w-8 fill-[#7854f6] text-[#7854f6] stroke-white" strokeWidth={2.5} />
            <span>Lumap</span>
          </a>
          <Button variant="outline" className="h-10 gap-2 rounded-xl border-[#e8e7ed] px-3.5 font-medium text-[#30303a] shadow-none">
            <MapPin className="h-4 w-4" />
            London
            <ChevronDown className="ml-1 h-4 w-4 text-[#85838f]" />
          </Button>
        </div>
        <div className="flex items-center gap-3">
          <a href="/review" className="hidden h-10 items-center rounded-xl px-3 text-sm font-medium !text-[#484751] transition-colors hover:bg-[#f4f3f7] hover:!text-[#7854f6] sm:inline-flex">
            Review queue
          </a>
          <AddVenueDialog />
          <AuthMenu />
        </div>
      </header>
      <VenueHome />
      <AskPanel />
    </main>
  );
}
