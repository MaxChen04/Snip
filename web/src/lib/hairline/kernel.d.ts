// The kernel is untyped JavaScript; the figure is the only thing that reaches into it.
export declare const HL: {
  inject(root: Document): void
  mk(tag: string, attrs: Record<string, string>, parent: Element): SVGElement
  tour(stage: HTMLElement, stops: ([number, number] | null)[], onStop?: (i: number) => void): { stop(): void }
  reducedMotion(): boolean
}
