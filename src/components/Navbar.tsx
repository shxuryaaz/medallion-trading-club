import { motion } from "motion/react";

export default function Navbar() {
  return (
    <motion.nav 
      initial={{ y: -20, opacity: 0 }}
      animate={{ y: 0, opacity: 1 }}
      className="fixed top-0 left-0 right-0 z-50 flex items-center justify-between px-8 py-6 bg-black/50 backdrop-blur-sm border-b border-white/5"
    >
      <div className="flex items-center gap-2">
        <div className="w-8 h-8 bg-white rounded-full flex items-center justify-center">
          <div className="w-4 h-4 bg-black rounded-sm rotate-45" />
        </div>
        <span className="font-sans font-semibold tracking-tighter text-xl uppercase">The Medallion Club</span>
      </div>
      
      <div className="hidden md:flex items-center gap-8 text-sm font-medium tracking-widest uppercase text-white/60">
        <a href="#" className="hover:text-white transition-colors">Philosophy</a>
        <a href="#" className="hover:text-white transition-colors">Performance</a>
        <a href="#" className="hover:text-white transition-colors">Access</a>
        <a href="#" className="hover:text-white transition-colors">Contact</a>
      </div>

      <button className="px-6 py-2 bg-white text-black text-xs font-bold uppercase tracking-widest hover:bg-white/90 transition-colors">
        Investor Login
      </button>
    </motion.nav>
  );
}
