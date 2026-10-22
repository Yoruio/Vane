'use client';

import { Cpu, Loader2, Search } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Popover, PopoverButton, PopoverPanel } from '@headlessui/react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { MinimalProvider } from '@/lib/models/types';
import { useChat } from '@/lib/hooks/useChat';
import { AnimatePresence, motion } from 'motion/react';
import { toast } from 'sonner';

/**
 * Asks the provider to bring a model's weights into memory, and reports what
 * happened in a toast that fades.
 *
 * Shared by the two ways a model becomes current: the user picking one, and the
 * page loading with one already selected. The only difference is whether an
 * already-resident model is worth mentioning -- on an explicit pick it confirms
 * the click did something, but on page load it is an unprompted toast about
 * something the user never asked for, so it stays silent.
 */
const requestPreload = (
  providerId: string,
  modelKey: string,
  { announceAlreadyLoaded }: { announceAlreadyLoaded: boolean },
) => {
  const toastId = `preload-${providerId}-${modelKey}`;
  let pending: ReturnType<typeof setTimeout> | undefined;

  const request = fetch('/api/models/preload', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ providerId, key: modelKey }),
  })
    .then((res) => res.json())
    .then((result) => {
      clearTimeout(pending);

      if (!result?.supported) {
        toast.dismiss(toastId);
        return;
      }

      /* A context warning outlives the load message: it is a configuration
       * problem the user has to act on, not a progress report. */
      if (result.warning) {
        toast.warning(result.warning, { id: toastId, duration: 10000 });
        return;
      }

      if (result.alreadyLoaded) {
        if (!announceAlreadyLoaded) {
          toast.dismiss(toastId);
          return;
        }

        toast.success(`${modelKey} is already loaded`, {
          id: toastId,
          duration: 2500,
        });
        return;
      }

      if (result.loaded) {
        toast.success(
          `${modelKey} loaded in ${(result.durationMs / 1000).toFixed(1)}s`,
          { id: toastId, duration: 4000 },
        );
        return;
      }

      toast.error(`Could not preload ${modelKey}`, {
        id: toastId,
        duration: 4000,
      });
    })
    .catch(() => {
      clearTimeout(pending);
      toast.dismiss(toastId);
    });

  /* Only say anything if it is slow enough to be worth a message -- a hosted
   * provider answers in milliseconds and should stay silent. */
  pending = setTimeout(() => {
    toast.loading(`Loading ${modelKey}…`, { id: toastId });
  }, 600);

  return request;
};

const ModelSelector = () => {
  const [providers, setProviders] = useState<MinimalProvider[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');

  const { setChatModelProvider, chatModelProvider } = useChat();

  useEffect(() => {
    const loadProviders = async () => {
      try {
        setIsLoading(true);
        const res = await fetch('/api/providers');

        if (!res.ok) {
          throw new Error('Failed to fetch providers');
        }

        const data: { providers: MinimalProvider[] } = await res.json();
        setProviders(data.providers);
      } catch (error) {
        console.error('Error loading providers:', error);
      } finally {
        setIsLoading(false);
      }
    };

    loadProviders();
  }, []);

  /* Warm the already-selected model when the page loads, not just when someone
   * opens the dropdown. Most visits never touch the selector, so without this
   * the ~26s load landed on the first model call of the first search.
   *
   * Keyed off useChat's resolved selection rather than localStorage: on a first
   * visit nothing is stored yet and useChat falls back to the first configured
   * model, which is the one the search will actually use.
   *
   * Fires once per mount. An explicit pick is already covered by
   * handleModelSelect, and this component only mounts on the empty-chat screen,
   * so it does not re-fire while navigating an existing conversation. */
  const warmed = useRef<string | null>(null);

  useEffect(() => {
    if (!chatModelProvider?.providerId || !chatModelProvider?.key) return;

    const current = `${chatModelProvider.providerId}/${chatModelProvider.key}`;
    if (warmed.current === current) return;
    warmed.current = current;

    requestPreload(chatModelProvider.providerId, chatModelProvider.key, {
      announceAlreadyLoaded: false,
    });
  }, [chatModelProvider]);

  const orderedProviders = useMemo(() => {
    if (!chatModelProvider?.providerId) return providers;

    const currentProviderIndex = providers.findIndex(
      (p) => p.id === chatModelProvider.providerId,
    );

    if (currentProviderIndex === -1) {
      return providers;
    }

    const selectedProvider = providers[currentProviderIndex];
    const remainingProviders = providers.filter(
      (_, index) => index !== currentProviderIndex,
    );

    return [selectedProvider, ...remainingProviders];
  }, [providers, chatModelProvider]);

  const handleModelSelect = (providerId: string, modelKey: string) => {
    setChatModelProvider({ providerId, key: modelKey });
    localStorage.setItem('chatModelProviderId', providerId);
    localStorage.setItem('chatModelKey', modelKey);

    /* Fire and forget: the load overlaps the user typing instead of landing on
     * the first model call of the search. */
    return requestPreload(providerId, modelKey, {
      announceAlreadyLoaded: true,
    });
  };

  const filteredProviders = orderedProviders
    .map((provider) => ({
      ...provider,
      chatModels: provider.chatModels.filter(
        (model) =>
          model.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
          provider.name.toLowerCase().includes(searchQuery.toLowerCase()),
      ),
    }))
    .filter((provider) => provider.chatModels.length > 0);

  return (
    <Popover className="relative w-full max-w-[15rem] md:max-w-md lg:max-w-lg">
      {({ open }) => (
        <>
          <PopoverButton
            type="button"
            className="active:border-none hover:bg-light-200  hover:dark:bg-dark-200 p-2 rounded-lg focus:outline-none headless-open:text-black dark:headless-open:text-white text-black/50 dark:text-white/50 active:scale-95 transition duration-200 hover:text-black dark:hover:text-white"
          >
            <Cpu size={16} className="text-sky-500" />
          </PopoverButton>
          <AnimatePresence>
            {open && (
              <PopoverPanel
                className="absolute z-10 w-[230px] sm:w-[270px] md:w-[300px] right-0"
                static
              >
                <motion.div
                  initial={{ opacity: 0, scale: 0.9 }}
                  animate={{ opacity: 1, scale: 1 }}
                  exit={{ opacity: 0, scale: 0.9 }}
                  transition={{ duration: 0.1, ease: 'easeOut' }}
                  className="origin-top-right bg-light-primary dark:bg-dark-primary max-h-[300px] sm:max-w-none border rounded-lg border-light-200 dark:border-dark-200 w-full flex flex-col shadow-lg overflow-hidden"
                >
                  <div className="p-2 border-b border-light-200 dark:border-dark-200">
                    <div className="relative">
                      <Search
                        size={16}
                        className="absolute left-3 top-1/2 -translate-y-1/2 text-black/40 dark:text-white/40"
                      />
                      <input
                        type="text"
                        placeholder="Search models..."
                        value={searchQuery}
                        onChange={(e) => setSearchQuery(e.target.value)}
                        className="w-full pl-8 pr-3 py-2 bg-light-secondary dark:bg-dark-secondary rounded-lg placeholder:text-xs placeholder:-translate-y-[1.5px] text-xs text-black dark:text-white placeholder:text-black/40 dark:placeholder:text-white/40 focus:outline-none border border-transparent transition duration-200"
                      />
                    </div>
                  </div>

                  <div className="max-h-[320px] overflow-y-auto">
                    {isLoading ? (
                      <div className="flex items-center justify-center py-16">
                        <Loader2
                          className="animate-spin text-black/40 dark:text-white/40"
                          size={24}
                        />
                      </div>
                    ) : filteredProviders.length === 0 ? (
                      <div className="text-center py-16 px-4 text-black/60 dark:text-white/60 text-sm">
                        {searchQuery
                          ? 'No models found'
                          : 'No chat models configured'}
                      </div>
                    ) : (
                      <div className="flex flex-col">
                        {filteredProviders.map((provider, providerIndex) => (
                          <div key={provider.id}>
                            <div className="px-4 py-2.5 sticky top-0 bg-light-primary dark:bg-dark-primary border-b border-light-200/50 dark:border-dark-200/50">
                              <p className="text-xs text-black/50 dark:text-white/50 uppercase tracking-wider">
                                {provider.name}
                              </p>
                            </div>

                            <div className="flex flex-col px-2 py-2 space-y-0.5">
                              {provider.chatModels.map((model) => (
                                <button
                                  key={model.key}
                                  onClick={() =>
                                    handleModelSelect(provider.id, model.key)
                                  }
                                  type="button"
                                  className={cn(
                                    'px-3 py-2 flex items-center justify-between text-start duration-200 cursor-pointer transition rounded-lg group',
                                    chatModelProvider?.providerId ===
                                      provider.id &&
                                      chatModelProvider?.key === model.key
                                      ? 'bg-light-secondary dark:bg-dark-secondary'
                                      : 'hover:bg-light-secondary dark:hover:bg-dark-secondary',
                                  )}
                                >
                                  <div className="flex items-center space-x-2.5 min-w-0 flex-1">
                                    <Cpu
                                      size={15}
                                      className={cn(
                                        'shrink-0',
                                        chatModelProvider?.providerId ===
                                          provider.id &&
                                          chatModelProvider?.key === model.key
                                          ? 'text-sky-500'
                                          : 'text-black/50 dark:text-white/50 group-hover:text-black/70 group-hover:dark:text-white/70',
                                      )}
                                    />
                                    <p
                                      className={cn(
                                        'text-xs truncate',
                                        chatModelProvider?.providerId ===
                                          provider.id &&
                                          chatModelProvider?.key === model.key
                                          ? 'text-sky-500 font-medium'
                                          : 'text-black/70 dark:text-white/70 group-hover:text-black dark:group-hover:text-white',
                                      )}
                                    >
                                      {model.name}
                                    </p>
                                  </div>
                                </button>
                              ))}
                            </div>

                            {providerIndex < filteredProviders.length - 1 && (
                              <div className="h-px bg-light-200 dark:bg-dark-200" />
                            )}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </motion.div>
              </PopoverPanel>
            )}
          </AnimatePresence>
        </>
      )}
    </Popover>
  );
};

export default ModelSelector;
