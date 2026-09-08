import { AudioProvider, useAudio } from '@/contexts/AudioContext';
import { UIModeProvider, useUIMode } from '@/contexts/UIModeContext';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { Sheet, SheetTrigger, SheetContent } from '@/components/ui/sheet';
import { Button } from '@/components/ui/button';
import { PanelLeft, Gauge } from 'lucide-react';
import Header from '@/components/mastering/Header';
import AudioUpload from '@/components/mastering/AudioUpload';
import WaveformDisplay from '@/components/mastering/WaveformDisplay';
import TransportControls from '@/components/mastering/TransportControls';
import {
  InputGainModule,
  NoiseGateModule,
  ParametricEQModule,
  DeEsserModule,
  MultibandCompModule,
  StereoCompModule,
  SaturationModule,
  StereoWidthModule,
  LimiterModule,
} from '@/components/mastering/ProcessingModules';
import MidSideEQModule from '@/components/mastering/MidSideEQModule';
import MeteringPanel from '@/components/mastering/MeteringPanel';
import AIPresetsPanel from '@/components/mastering/AIPresetsPanel';
import SpectralDiff from '@/components/mastering/SpectralDiff';
import LoudnessPenalty from '@/components/mastering/LoudnessPenalty';
import AccountPanel from '@/components/mastering/AccountPanel';
import SnapshotBar from '@/components/mastering/SnapshotBar';
import PresetLibrary from '@/components/mastering/PresetLibrary';
import ReferenceTrack from '@/components/mastering/ReferenceTrack';
import SessionHistory from '@/components/mastering/SessionHistory';
import ExportPanel from '@/components/mastering/ExportPanel';
import AIFixPanel from '@/components/mastering/AIFixPanel';
import AICopilotChat from '@/components/mastering/AICopilotChat';
import QualityScore from '@/components/mastering/QualityScore';
import OneClickMaster from '@/components/mastering/OneClickMaster';
import NextSteps from '@/components/mastering/NextSteps';
import GuidedTour from '@/components/mastering/GuidedTour';
import { TourProvider } from '@/contexts/TourContext';
import { Seo } from '@/components/Seo';


/**
 * Unified mastering console.
 * One shell for every mode — Header · Transport strip · Left rail · Main · Right meter rail.
 * Mode only changes which panels appear in Left rail / Main; layout stays identical.
 */
const MasteringApp = () => {
  const { state } = useAudio();
  const { mode } = useUIMode();

  if (!state.audioBuffer) {
    return (
      <div className="min-h-screen bg-background noise-texture flex flex-col">
        <Header />
        <GuidedTour />
        <div className="flex-1 px-2 sm:px-4 pb-4">
          <div className="max-w-6xl mx-auto w-full grid grid-cols-1 lg:grid-cols-12 gap-4">
            <div className="lg:col-span-8" data-tour="upload">
              <AudioUpload />
            </div>
            <aside className="lg:col-span-4">
              <NextSteps />
            </aside>
          </div>
        </div>
      </div>
    );
  }



  // Left rail content per mode
  const LeftRail = () => {
    if (mode === 'quick') return (
      <>
        <NextSteps />
        <div data-tour="one-click"><OneClickMaster /></div>
        <AccountPanel />
      </>
    );
    return (
      <>
        <NextSteps />
        <div data-tour="copilot"><AICopilotChat /></div>
        <div data-tour="ai-presets"><AIPresetsPanel /></div>
        <PresetLibrary />
        <div data-tour="reference"><ReferenceTrack /></div>
        {mode === 'pro' && <SessionHistory />}
        <AccountPanel />
      </>
    );
  };

  // Main content per mode
  const MainArea = () => {
    if (mode === 'quick') {
      return (
        <>
          <div data-tour="quality"><QualityScore /></div>
          <SpectralDiff />
          <LoudnessPenalty />
        </>
      );
    }

    if (mode === 'smart') {
      return (
        <>
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <div data-tour="quality"><QualityScore /></div>
            <div data-tour="ai-fix"><AIFixPanel /></div>
          </div>
          <SpectralDiff />
          <LoudnessPenalty />
          <div data-tour="export"><ExportPanel /></div>
          <SessionHistory />
        </>
      );
    }

    // Pro — DSP grouped into tabs for clarity
    return (
      <>
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <div data-tour="quality"><QualityScore /></div>
          <div data-tour="ai-fix"><AIFixPanel /></div>
        </div>
        <SpectralDiff />

        <div className="panel p-3" data-tour="dsp-tabs">
          <Tabs defaultValue="dynamics" className="w-full">
            <TabsList className="grid grid-cols-4 w-full mb-3">
              <TabsTrigger value="input">Input</TabsTrigger>
              <TabsTrigger value="tone">Tone</TabsTrigger>
              <TabsTrigger value="dynamics">Dynamics</TabsTrigger>
              <TabsTrigger value="output">Stereo &amp; Output</TabsTrigger>
            </TabsList>

            <TabsContent value="input" className="grid grid-cols-1 lg:grid-cols-2 gap-4 mt-0">
              <InputGainModule />
              <NoiseGateModule />
            </TabsContent>

            <TabsContent value="tone" className="grid grid-cols-1 lg:grid-cols-2 gap-4 mt-0">
              <ParametricEQModule />
              <MidSideEQModule />
              <DeEsserModule />
              <SaturationModule />
            </TabsContent>

            <TabsContent value="dynamics" className="grid grid-cols-1 lg:grid-cols-2 gap-4 mt-0">
              <MultibandCompModule />
              <StereoCompModule />
            </TabsContent>

            <TabsContent value="output" className="grid grid-cols-1 lg:grid-cols-2 gap-4 mt-0">
              <StereoWidthModule />
              <LimiterModule />
            </TabsContent>
          </Tabs>
        </div>

        <LoudnessPenalty />
        <div data-tour="export"><ExportPanel /></div>
      </>
    );
  };

  return (
    <div className="min-h-screen bg-background noise-texture flex flex-col">
      <Header />
      <GuidedTour />


      {/* Unified transport strip — always on top of the console */}
      <div className="border-b border-border bg-card/50 px-2 sm:px-3 py-2 space-y-2">
        <WaveformDisplay />
        <div className="flex flex-wrap items-center justify-between gap-2 sm:gap-4">
          <TransportControls />
          <SnapshotBar />
          <AudioUpload />
        </div>
      </div>

      {/* Mobile / tablet rail access */}
      <div className="flex xl:hidden items-center gap-2 border-b border-border bg-card/30 px-2 py-2">
        <Sheet>
          <SheetTrigger asChild>
            <Button variant="outline" size="sm" className="flex-1 gap-2">
              <PanelLeft className="w-4 h-4" /> Panel AI
            </Button>
          </SheetTrigger>
          <SheetContent side="left" className="w-[88vw] sm:w-96 overflow-y-auto p-3 space-y-4">
            <LeftRail />
          </SheetContent>
        </Sheet>
        <Sheet>
          <SheetTrigger asChild>
            <Button variant="outline" size="sm" className="flex-1 gap-2">
              <Gauge className="w-4 h-4" /> Mierniki
            </Button>
          </SheetTrigger>
          <SheetContent side="right" className="w-[88vw] sm:w-96 overflow-y-auto p-0">
            <MeteringPanel />
          </SheetContent>
        </Sheet>
      </div>

      <div className="flex-1 flex overflow-hidden">
        <aside className="hidden xl:block w-72 border-r border-border overflow-y-auto flex-shrink-0 p-3 space-y-4">
          <LeftRail />
        </aside>

        <main className="flex-1 overflow-y-auto p-2 sm:p-3 space-y-4 min-w-0">
          <MainArea />
        </main>

        <aside className="hidden xl:block w-56 border-l border-border overflow-y-auto flex-shrink-0">
          <MeteringPanel />
        </aside>
      </div>
    </div>
  );
};

const Index = () => (
  <UIModeProvider>
    <TourProvider>
      <AudioProvider>
        <Seo
          title="Konsola masteringu"
          path="/app"
          description="Konsola masteringu MasteringPro — wgraj utwór, przeanalizuj głośność i widmo, zbuduj łańcuch DSP i wyeksportuj gotowy master."
        />
        <MasteringApp />
      </AudioProvider>
    </TourProvider>
  </UIModeProvider>
);


export default Index;
