import { useEffect, useState } from "react"
import { AnimatePresence, motion } from "framer-motion"

import { Button } from "@/shared/ui/button"
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from "@/shared/ui/dialog"

type UpdateState = {
    open: boolean
    version: string
}

const initialState: UpdateState = {
    open: false,
    version: "",
}

export default function UpdateModal() {
    const [state, setState] = useState<UpdateState>(initialState)

    useEffect(() => {
        window.updater.onUpdateReady((data) => {
            setState({
                open: true,
                version: data.version,
            })
        })
    }, [])

    return (
        <Dialog
            open={state.open}
            onOpenChange={(open) => {
                setState((current) => ({ ...current, open }))
            }}
        >
            <DialogContent
                showCloseButton={false}
                className="max-w-md border-border bg-bg-chatarea p-0 text-tx shadow-2xl"
            >
                <AnimatePresence mode="wait">
                    {state.open ? (
                        <motion.div
                            key={state.version || "update-ready"}
                            initial={{ opacity: 0, scale: 0.96 }}
                            animate={{ opacity: 1, scale: 1 }}
                            exit={{ opacity: 0, scale: 0.98 }}
                            transition={{ duration: 0.18, ease: "easeOut" }}
                            className="overflow-hidden rounded-lg"
                        >
                            <DialogHeader className="border-b border-border/60 px-6 pt-6 pb-4 text-left">
                                <DialogTitle className="text-lg font-semibold">
                                    Update Ready
                                </DialogTitle>
                                <DialogDescription className="text-sm text-tx/65">
                                    Version {state.version} has been downloaded and is ready to install.
                                </DialogDescription>
                            </DialogHeader>

                            <div className="px-6 py-5 text-sm leading-6 text-tx/75">
                                Restart the app now to finish installing the update.
                            </div>

                            <DialogFooter className="border-t border-border/60 px-6 py-4 sm:justify-end">
                                <Button
                                    type="button"
                                    variant="ghost"
                                    className="bg-white/5 text-tx hover:bg-white/10"
                                    onClick={() => {
                                        setState((current) => ({ ...current, open: false }))
                                    }}
                                >
                                    Later
                                </Button>
                                <Button
                                    type="button"
                                    className="bg-white text-black hover:bg-white/90"
                                    onClick={() => {
                                        window.updater.restart()
                                    }}
                                >
                                    Restart
                                </Button>
                            </DialogFooter>
                        </motion.div>
                    ) : null}
                </AnimatePresence>
            </DialogContent>
        </Dialog>
    )
}
