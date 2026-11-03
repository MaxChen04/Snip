export interface HairlineRead {
  textContent: string | null
}
export interface HairlineFigure {
  name: string
  means: string
  range: [number, number, number]
  tour: ([number, number] | null)[] | null
  mount(host: { stage: HTMLElement; svg: SVGElement; read: HairlineRead }, value: number): { set(value: number): void; destroy(): void }
}
export declare const network: HairlineFigure
/** [part index, viewBox y] where each leader line ends; the page puts its labels there. */
export declare const LEADS: [number, number][]
