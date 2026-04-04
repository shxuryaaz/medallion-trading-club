import { motion } from "motion/react";
import { ArrowRight } from "lucide-react";

export default function Hero() {
  return (
    <section className="relative min-h-screen flex flex-col items-center justify-center pt-20 overflow-hidden">
      {/* Subtle background gradient */}
      <div className="absolute inset-0 bg-[radial-gradient(circle_at_50%_50%,rgba(255,255,255,0.05),transparent_70%)]" />
      
      <div className="container mx-auto px-6 text-center relative z-10">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.8 }}
          className="mb-6 inline-block px-4 py-1 border border-white/10 rounded-full text-[10px] uppercase tracking-[0.3em] text-white/40"
        >
          Institutional Grade AI Intelligence
        </motion.div>
        
        <motion.h1 
          initial={{ opacity: 0, y: 30 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.8, delay: 0.2 }}
          className="text-6xl md:text-8xl font-serif italic mb-8 leading-tight tracking-tight"
        >
          Precision in <br />
          <span className="text-gradient">Quantitative Alpha</span>
        </motion.h1>
        
        <motion.p 
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.8, delay: 0.4 }}
          className="max-w-2xl mx-auto text-lg text-white/50 font-light leading-relaxed mb-12"
        >
          The Medallion Club leverages proprietary neural architectures to identify market inefficiencies 
          with surgical precision. Where others see noise, we find signal.
        </motion.p>
        
        <motion.div 
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.8, delay: 0.6 }}
          className="flex flex-col sm:flex-row items-center justify-center gap-6"
        >
          <button className="group px-10 py-4 bg-white text-black text-sm font-bold uppercase tracking-widest hover:bg-white/90 transition-all flex items-center gap-2">
            Request Prospectus
            <ArrowRight className="w-4 h-4 group-hover:translate-x-1 transition-transform" />
          </button>
          <button className="px-10 py-4 border border-white/20 text-white text-sm font-bold uppercase tracking-widest hover:bg-white/5 transition-all">
            Our Methodology
          </button>
        </motion.div>
      </div>

      {/* Decorative element */}
      <motion.div 
        initial={{ opacity: 0 }}
        animate={{ opacity: 0.1 }}
        transition={{ duration: 2 }}
        className="absolute bottom-0 left-0 w-full h-px bg-gradient-to-r from-transparent via-white to-transparent"
      />
    </section>
  );
}
