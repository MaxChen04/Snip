import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react"
import { api, type Collection } from "@/lib/api"

const Ctx = createContext<{ collections: Collection[]; refresh: () => Promise<void> }>({
  collections: [],
  refresh: async () => {},
})

export function CollectionsProvider({ children }: { children: ReactNode }) {
  const [collections, setCollections] = useState<Collection[]>([])
  const refresh = useCallback(async () => setCollections(await api.collections()), [])
  useEffect(() => void refresh().catch(() => {}), [refresh])
  return <Ctx.Provider value={{ collections, refresh }}>{children}</Ctx.Provider>
}

export const useCollections = () => useContext(Ctx)
