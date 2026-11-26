; benchmark generated from python API
(set-info :status unknown)
(declare-fun logical_size () (_ BitVec 32))
(declare-fun addr () (_ BitVec 32))
(declare-fun base () (_ BitVec 32))
(declare-fun physical () (Array (_ BitVec 32) (_ BitVec 8)))
(declare-fun logical () (Array (_ BitVec 32) (_ BitVec 8)))
(assert
 (let ((?x15 ((_ zero_extend 32) logical_size)))
 (bvsle (bvadd ((_ zero_extend 32) addr) (_ bv2 64)) ?x15)))
(assert
 (bvsle (bvadd ((_ zero_extend 32) base) ((_ zero_extend 32) logical_size)) (_ bv4294967296 64)))
(assert
 (let ((?x24 (bvadd base addr)))
 (let ((?x25 (bvadd ?x24 (_ bv0 32))))
 (let ((?x26 (select physical ?x25)))
 (let ((?x22 (bvadd addr (_ bv0 32))))
 (let ((?x23 (select logical ?x22)))
 (= ?x23 ?x26)))))))
(assert
 (let ((?x197 (select physical (bvadd (bvadd base addr) (_ bv1 32)))))
 (let ((?x14 (select logical (bvadd addr (_ bv1 32)))))
 (= ?x14 ?x197))))
(assert
 (let ((?x24 (bvadd base addr)))
(let ((?x25 (bvadd ?x24 (_ bv0 32))))
(let ((?x26 (select physical ?x25)))
(let ((?x197 (select physical (bvadd ?x24 (_ bv1 32)))))
(let ((?x138 (concat ?x197 ?x26)))
(let ((?x153 ((_ zero_extend 16) ?x138)))
(let ((?x31 (bvadd (_ bv0 32) (bvmul ((_ zero_extend 24) (select logical (bvadd addr (_ bv0 32)))) (_ bv1 32)))))
(let ((?x139 (bvadd ?x31 (bvmul ((_ zero_extend 24) (select logical (bvadd addr (_ bv1 32)))) (_ bv256 32)))))
(and (distinct ?x139 ?x153) true))))))))))
(check-sat)
