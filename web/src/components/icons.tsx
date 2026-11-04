import { forwardRef } from "react"
import { HugeiconsIcon, type HugeiconsProps, type IconSvgElement } from "@hugeicons/react"
import {
  Add01Icon,
  Alert02Icon,
  AlertCircleIcon as HAlertCircle,
  ArrowDown01Icon,
  ArrowLeft01Icon,
  ArrowReloadHorizontalIcon,
  ArrowRight01Icon,
  ArrowRight02Icon,
  ArrowTurnBackwardIcon,
  ArrowUpRight01Icon,
  Bookmark02Icon,
  Cancel01Icon,
  CancelCircleIcon,
  CheckmarkCircle02Icon,
  ClipboardIcon as HClipboard,
  Clock01Icon,
  CommandLineIcon,
  ComputerIcon,
  Copy01Icon,
  DatabaseIcon,
  Delete02Icon,
  Download01Icon,
  EyeIcon,
  File01Icon,
  Folder01Icon,
  FolderAddIcon,
  FolderMinusIcon as HFolderMinus,
  Globe02Icon,
  HardDriveIcon as HHardDrive,
  HierarchyIcon,
  InformationCircleIcon,
  Key01Icon,
  LaptopIcon as HLaptop,
  Link02Icon,
  Loading03Icon,
  Logout01Icon,
  MinusSignIcon,
  Moon02Icon,
  MoreHorizontalIcon as HMoreHorizontal,
  PauseIcon as HPause,
  PencilEdit02Icon,
  PlayIcon as HPlay,
  PanelRightCloseIcon as HPanelRightClose,
  PanelRightOpenIcon as HPanelRightOpen,
  Plug01Icon,
  ServerStack01Icon,
  ShieldKeyIcon,
  SmartPhone01Icon,
  SparklesIcon as HSparkles,
  SquareArrowUpRightIcon,
  StopIcon as HStop,
  SquareLock02Icon,
  Search01Icon,
  Sun03Icon,
  Tick02Icon,
} from "@hugeicons/core-free-icons"

// Hugeicons behind the names the app already uses, so a component only swaps its import line.
// Stroke 2 on the 24px grid renders about 1.33px at 16px, close to the 1.5px marks token.

export type IconProps = Omit<HugeiconsProps, "icon">
export type Icon = ReturnType<typeof make>

function make(icon: IconSvgElement, name: string) {
  const C = forwardRef<SVGSVGElement, IconProps>(function C(props, ref) {
    return <HugeiconsIcon ref={ref} icon={icon} strokeWidth={2} aria-hidden="true" {...props} />
  })
  C.displayName = name
  return C
}

export const AlertCircleIcon = make(HAlertCircle, "AlertCircleIcon")
export const ArrowLeft = make(ArrowLeft01Icon, "ArrowLeft")
export const ArrowRight = make(ArrowRight02Icon, "ArrowRight")
export const ArrowUpRightIcon = make(ArrowUpRight01Icon, "ArrowUpRightIcon")
export const BookmarkIcon = make(Bookmark02Icon, "BookmarkIcon")
export const CheckIcon = make(Tick02Icon, "CheckIcon")
export const Check = CheckIcon
export const ChevronDownIcon = make(ArrowDown01Icon, "ChevronDownIcon")
export const ChevronRightIcon = make(ArrowRight01Icon, "ChevronRightIcon")
export const CircleCheckIcon = make(CheckmarkCircle02Icon, "CircleCheckIcon")
export const ClipboardIcon = make(HClipboard, "ClipboardIcon")
export const Clock = make(Clock01Icon, "Clock")
export const CopyIcon = make(Copy01Icon, "CopyIcon")
export const CornerDownLeftIcon = make(ArrowTurnBackwardIcon, "CornerDownLeftIcon")
export const Database = make(DatabaseIcon, "Database")
export const DownloadIcon = make(Download01Icon, "DownloadIcon")
export const ExternalLinkIcon = make(SquareArrowUpRightIcon, "ExternalLinkIcon")
export const Eye = make(EyeIcon, "Eye")
export const FileIcon = make(File01Icon, "FileIcon")
export const FolderIcon = make(Folder01Icon, "FolderIcon")
export const FolderPlusIcon = make(FolderAddIcon, "FolderPlusIcon")
export const FolderMinusIcon = make(HFolderMinus, "FolderMinusIcon")
export const GlobeIcon = make(Globe02Icon, "GlobeIcon")
export const HardDrive = make(HHardDrive, "HardDrive")
export const InfoIcon = make(InformationCircleIcon, "InfoIcon")
export const KeyRound = make(Key01Icon, "KeyRound")
export const LaptopIcon = make(HLaptop, "LaptopIcon")
export const Link2 = make(Link02Icon, "Link2")
export const Loader2Icon = make(Loading03Icon, "Loader2Icon")
export const Lock = make(SquareLock02Icon, "Lock")
export const LogOutIcon = make(Logout01Icon, "LogOutIcon")
export const MinusIcon = make(MinusSignIcon, "MinusIcon")
export const MonitorIcon = make(ComputerIcon, "MonitorIcon")
export const Monitor = MonitorIcon
export const MoonIcon = make(Moon02Icon, "MoonIcon")
export const MoreHorizontalIcon = make(HMoreHorizontal, "MoreHorizontalIcon")
export const NetworkIcon = make(HierarchyIcon, "NetworkIcon")
export const OctagonXIcon = make(CancelCircleIcon, "OctagonXIcon")
export const PauseIcon = make(HPause, "PauseIcon")
export const PlayIcon = make(HPlay, "PlayIcon")
export const PencilIcon = make(PencilEdit02Icon, "PencilIcon")
export const PenLine = PencilIcon
export const PanelRightCloseIcon = make(HPanelRightClose, "PanelRightCloseIcon")
export const PanelRightOpenIcon = make(HPanelRightOpen, "PanelRightOpenIcon")
export const PlugIcon = make(Plug01Icon, "PlugIcon")
export const PlusIcon = make(Add01Icon, "PlusIcon")
export const RefreshCwIcon = make(ArrowReloadHorizontalIcon, "RefreshCwIcon")
export const SearchIcon = make(Search01Icon, "SearchIcon")
export const Server = make(ServerStack01Icon, "Server")
export const ShieldCheckIcon = make(ShieldKeyIcon, "ShieldCheckIcon")
export const SmartphoneIcon = make(SmartPhone01Icon, "SmartphoneIcon")
export const SparklesIcon = make(HSparkles, "SparklesIcon")
export const StopIcon = make(HStop, "StopIcon")
export const SunIcon = make(Sun03Icon, "SunIcon")
export const TerminalIcon = make(CommandLineIcon, "TerminalIcon")
export const Terminal = TerminalIcon
export const Trash2Icon = make(Delete02Icon, "Trash2Icon")
export const TriangleAlertIcon = make(Alert02Icon, "TriangleAlertIcon")
export const XIcon = make(Cancel01Icon, "XIcon")
